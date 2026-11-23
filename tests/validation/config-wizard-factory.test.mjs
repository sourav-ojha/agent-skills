// `deliver config edit --profile factory`: the file-derived start checks (lib/factorycheck.mjs) and the checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO, tmpDir } from './helpers.mjs';

const SCRIPTS = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const imp = (...p) => import(pathToFileURL(path.join(SCRIPTS, ...p)).href);
const { parseConfig } = await imp('lib', 'config.mjs');
const FC = await imp('lib', 'factorycheck.mjs');
const FX = await imp('factory.mjs');
const { runConfigCommand } = await imp('lib', 'configcmd.mjs');

const GOOD = {
  verification: { required: true }, readiness: { min_level: 4 },
  app: { start: ['npm', 'start'], base_url: 'http://127.0.0.1:3000', ready: { url: 'http://127.0.0.1:3000/health', timeout_s: 60 } },
};
const merged = (over) => ({ ...GOOD, ...over });
const SAMPLES = [
  ['empty', {}, ['app_base_url', 'app_ready', 'app_start', 'readiness_level', 'verification']],
  ['complete', GOOD, []],
  ['readiness below 4', merged({ readiness: { min_level: 3 } }), ['readiness_level']],
  ['local_checks', merged({ local_checks: [{ name: 'lint', command: ['npm', 'run', 'lint'] }] }), ['local_checks']],
  ['required verified', merged({ checks: { required: ['Factory/Verified'] } }), ['required_verified']],
  ['ready on another port', merged({ app: { ...GOOD.app, ready: { url: 'http://127.0.0.1:4000/', timeout_s: 60 } } }), ['app_ready']],
  ['log_pattern ready', merged({ app: { ...GOOD.app, ready: { log_pattern: 'listening', timeout_s: 60 } } }), []],
  ['base_url without port', merged({ app: { start: ['x'] } }), ['app_base_url', 'app_ready']],
];
const policyOf = (doc) => { const r = parseConfig(doc); assert.deepEqual(r.errors, [], JSON.stringify(doc)); return r.config; };

test('fileProblems: ids per sample document', () => {
  for (const [name, doc, ids] of SAMPLES) {
    const got = FC.fileProblems(policyOf(doc));
    assert.deepEqual(got.map((p) => p.id).sort(), ids, name);
    for (const p of got) assert.ok(p.why && p.fix, `${name} ${p.id}`);
  }
});

test('merge_mode is a note, never a problem', () => {
  assert.equal(FC.fileProblems(policyOf({})).some((p) => p.id === 'merge_mode'), false);
  const n = FC.fileNotes(policyOf({}));
  assert.equal(n.length, 1); assert.equal(n[0].id, 'merge_mode'); assert.equal(n[0].note, true);
  assert.match(n[0].why, /pr-only/);
  assert.deepEqual(FC.fileNotes(policyOf({ autonomy: { level: 'L1' } })), []);
});

test('outsideFile lists the three items with their commands', () => {
  const o = FC.outsideFile();
  assert.equal(o.length, 3);
  assert.match(o.map((x) => x.command).join('\n'), /deliver readiness[\s\S]*factory scenarios[\s\S]*/);
  assert.ok(o.some((x) => /branch protection/i.test(x.what) && /factory\/verified/.test(x.what)));
});

// The agreement test: the driver's own refusal carries the same words for the checks the file decides.
test('the shared why strings equal what startChecks refuses with', () => {
  const ids = ['verification', 'readiness_level', 'local_checks', 'required_verified'];
  for (const [name, doc] of SAMPLES) {
    const policy = policyOf(doc);
    const ctx = { policy, base: 'main', fh: path.join(tmpDir('fc-'), 'none'), key: 'k', id: { repo: 'o/r' }, out: () => {}, gh: () => ({ code: 1, out: '', err: 'stub' }) };
    let msg = '';
    try { FX.startChecks(ctx); } catch (e) { msg = e.message; }
    const driver = msg.replace(/^factory run needs: /, '').split('; ');
    const mine = FC.fileProblems(policy).filter((p) => ids.includes(p.id));
    for (const p of mine) assert.ok(driver.includes(p.why), `${name}: ${p.id}: ${p.why}`);
  }
});

// ---- edit --profile factory ------------------------------------------------------------------------------------------
const project = (doc) => {
  const dir = tmpDir('cfg-fac-');
  fs.mkdirSync(path.join(dir, '.product'));
  const file = path.join(dir, '.product', 'delivery.json');
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { dir, file };
};
const edit = async (dir, answers, { profile = 'factory', tty = true, confirm = 'n', eof = false } = {}) => {
  const out = [], asked = [], rest = [...answers];
  const io = { out: (t) => out.push(t), err: (t) => out.push(t), ask: async (p) => {
    asked.push(p);
    if (eof) return null;
    if (/^Write /.test(p)) return confirm;
    return rest.length ? rest.shift() : '';
  } };
  const code = await runConfigCommand({ sub: 'edit', args: [], opt: { profile }, root: dir, home: path.join(dir, 'fhome'), tty, io });
  return { code, out: out.join('\n'), asked };
};
test('edit --profile factory walks only the profile keys and prints the checklist', async () => {
  const { dir, file } = project({ base: 'develop', budgets: { feature: { tokens: 1000000 } } });
  const before = fs.readFileSync(file);
  const r = await edit(dir, []);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fs.readFileSync(file), before);
  // readiness.min_level is asked only once readiness is opted in (the readiness switch comes first)
  for (const k of FC.FACTORY_KEYS.map((x) => (x === 'readiness.min_level' ? 'readiness' : x))) assert.match(r.out, new RegExp(`^${k.replace('.', '\\.')}   \\(current`, 'm'), k);
  for (const other of ['base', 'budgets.feature.tokens', 'merge.mode', 'protected_branches', 'verification.scenario_approval', 'readiness.max_age_days']) {
    assert.doesNotMatch(r.out, new RegExp(`^${other.replace('.', '\\.')}\\b`, 'm'), other);
  }
  assert.match(r.out, /fix: set "verification"/);
  assert.match(r.out, /check outside this file:/);
  assert.match(r.out, /deliver readiness/); assert.match(r.out, /factory scenarios/); assert.match(r.out, /branch protection/i);
});

test('edit --profile factory: a complete file prints no problems, only the outside items', async () => {
  const { dir } = project(GOOD);
  const r = await edit(dir, ['q']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /fix:/);
  assert.match(r.out, /check outside this file:/);
});

test('edit --profile factory: answers change the policy and the checklist reflects the written file', async () => {
  const { dir, file } = project({});
  const r = await edit(dir, ['true'], { confirm: 'y' });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).verification.required, true);
  assert.doesNotMatch(r.out, /fix: set "verification"/);
});

test('edit --profile: closed input exits 1 without the checklist; bad profile exits 1', async () => {
  const { dir } = project({});
  const eof = await edit(dir, [], { eof: true });
  assert.equal(eof.code, 1); assert.doesNotMatch(eof.out, /check outside this file/);
  const bad = await edit(dir, [], { profile: 'nope' });
  assert.equal(bad.code, 1); assert.match(bad.out, /basic/); assert.match(bad.out, /factory/);
  assert.equal(bad.asked.length, 0);
});
