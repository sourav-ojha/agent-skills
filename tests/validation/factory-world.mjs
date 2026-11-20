// Shared integration harness for the factory driver tests: a local bare origin, the fake gh, the fake claude as `claude`, and the
// factory harness (tests/fixtures/factory-harness.mjs) run as a subprocess. Not a test file (no .test.mjs suffix).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

export const SCRIPTS = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const HARNESS = path.join(REPO, 'tests', 'fixtures', 'factory-harness.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const FAKE_CLAUDE = path.join(REPO, 'tests', 'fixtures', 'fake-claude', 'claude');

export const fspec = (id, title) => `---\ntype: feature-spec\nid: ${id}\nopportunity: OPP-001\nstatus: ready\n---\n# ${title}\n\n## Acceptance criteria\n\n| ID | Criterion |\n|---|---|\n| AC-1 | Given items When listing Then they are returned |\n\n## Edge cases\n\n- EC-1: an empty list returns an empty array\n\n## HTTP contract\n\n- \`GET /api/items\`\n- \`POST /api/items\`\n`;
export const HIDDEN = 'hidden-alpha-item';
export const AUTHOR_OK = JSON.stringify({ scenarios: [
  { id: 'S-1', covers: ['AC-1'], kind: 'api', setup: [{ method: 'POST', path: '/api/items', body: { name: `${HIDDEN} {{CANARY}}` } }], request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }, { json_path: '$.items[*].name', contains: `${HIDDEN} {{CANARY}}` }] },
  { id: 'S-2', covers: ['EC-1'], kind: 'api', request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }] },
] });
export const BASE_CONFIG = { protected_branches: [], merge: { mode: 'squash' }, checks: { required: ['ci'] }, readiness: { min_level: 4 }, verification: { required: true } };

// A bare origin with two ready API features, a fake gh (protection requiring factory/verified), the fake claude as `claude`.
export function world(t, { config = BASE_CONFIG, specs = { 'FEATURE-001': 'Items one', 'FEATURE-002': 'Items two' }, fake = {}, gh = {}, test = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin'), home = path.join(root, 'home'), fhome = path.join(root, 'fhome');
  for (const d of [bin, home, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(fhome, { mode: 0o700 });
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.symlinkSync(FAKE_CLAUDE, path.join(bin, 'claude'));
  const rw = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git', GIT_CONFIG_KEY_1: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_1: 'ssh://git@github.com/o/r.git' };
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...rw, HOME: home } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  for (const [id, title] of Object.entries(specs)) fs.writeFileSync(path.join(work, `.product/features/${id}.md`), fspec(id, title));
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(work, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(work, '.github/workflows/ci.yml'), 'name: ci\n');
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main'); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]], protection: { required_status_checks: { contexts: ['ci', 'factory/verified'] } }, enforceProtection: true, ...gh }));
  const log = path.join(root, 'claude.log');
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ mode: 'factory', log, author: { 'FEATURE-001': AUTHOR_OK, 'FEATURE-002': AUTHOR_OK }, ...fake }));
  const env = { ...process.env, ...rw, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: fhome, FACTORY_TEST: JSON.stringify(test) };
  delete env.FACTORY_BUILDER_HOME;
  const factory = (args, extra = {}) => { const r = spawnSync(process.execPath, [HARNESS, ...args, '--dir', work], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 240000 }); return { code: r.status, out: r.stdout, err: r.stderr, signal: r.signal }; };
  const ghState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const setGh = (fn) => { const s = ghState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  const setFake = (fn) => { const p = path.join(bin, 'fake.json'); const s = JSON.parse(fs.readFileSync(p, 'utf8')); fn(s); fs.writeFileSync(p, JSON.stringify(s)); };
  const sessions = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const queueFile = path.join(fhome, 'queues', 'o__r.json');
  const queue = () => JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const clone = path.join(fhome, 'clones', 'o__r');
  const records = () => { const f = path.join(clone, '.skill-runs', 'factory-runs.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const inHome = (fn) => { const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = fhome; try { return fn(); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; } };
  return { root, origin, work, bin, home, fhome, env, sh, factory, ghState, setGh, setFake, sessions, queue, queueFile, clone, records, inHome, builder: path.join(`${fhome}-builder`, 'o__r') };
}
export const noText = (s, extra = []) => { for (const x of [HIDDEN, 'fx-', '/api/items', ...extra]) assert.ok(!String(s).includes(x), `leaks ${x}: ${String(s).slice(0, 400)}`); };

// A stored readiness result at level 4 for the config now on origin/main (deliver init's gate re-checks C1, C2, C4 and C5).
export function readiness(w, level = 4) {
  const raw = fs.readFileSync(path.join(w.work, '.product/delivery.json'));
  const doc = { helper_version: '0.1.0', base: 'main', base_sha: w.sh(w.work, 'rev-parse', 'HEAD'), config_hash: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`, level,
    results: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].map((id) => ({ id, status: 'pass', reason: '' })), fixes: [], at: new Date().toISOString() };
  fs.mkdirSync(path.join(w.fhome, 'readiness'), { recursive: true });
  fs.writeFileSync(path.join(w.fhome, 'readiness', 'o__r.json'), JSON.stringify(doc));
}
export const good = (id, extra = {}) => ({ files: { [`src/${id}.txt`]: 'good\n', ...extra }, spec_complete: true, commit: true, pr_body: `Implements ${id}.\n` });
export const ready = (t, opts = {}) => { const w = world(t, opts); readiness(w); const s = w.factory(['scenarios']); assert.equal(s.code, 0, s.out + s.err); return w; };
export const builderRuns = (w, id) => w.sessions().filter((s) => !s.argv.includes('--tools') && s.argv[s.argv.indexOf('-p') + 1].includes(id));
export const promptOf = (s) => s.argv[s.argv.indexOf('-p') + 1];
export const verifyCalls = (w) => { const f = path.join(w.fhome, 'verify-calls.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };
