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

// ---- Task 5 review leftovers: loosening, --local refusal, declined write ---------------------------------------------
test('edit --profile factory: a loosening needs a typed yes; anything else keeps the old value and leaves the bytes', async () => {
  const { dir, file } = project(GOOD);
  const before = fs.readFileSync(file);
  const no = await edit(dir, ['false', 'no'], { confirm: 'y' });
  assert.equal(no.code, 0, no.out);
  assert.match(no.out, /turns off the verification gate/); assert.match(no.out, /kept the old value/);
  assert.deepEqual(fs.readFileSync(file), before);
  const yes = await edit(dir, ['false', 'yes'], { confirm: 'y' });
  assert.equal(yes.code, 0, yes.out);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).verification.required, false);
});

test('edit --profile factory: --local is refused with exit 1 and a message', async () => {
  const { dir } = project({});
  const out = [];
  const code = await runConfigCommand({ sub: 'edit', args: [], opt: { profile: 'factory', local: true }, root: dir, home: path.join(dir, 'fhome'), tty: true, io: { out: (t) => out.push(t), err: (t) => out.push(t), ask: async () => '' } });
  assert.equal(code, 1); assert.match(out.join('\n'), /--profile factory/);
});

test('edit --profile factory: a declined final write still prints the checklist, exits 0, bytes unchanged', async () => {
  const { dir, file } = project({});
  const before = fs.readFileSync(file);
  const r = await edit(dir, ['true'], { confirm: 'n' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing written/); assert.match(r.out, /factory checklist:/); assert.match(r.out, /check outside this file:/);
  assert.deepEqual(fs.readFileSync(file), before);
});

// ---- local config (--local) ---------------------------------------------------------------------------------------------
const { spawnSync } = await import('node:child_process');
const L = await imp('lib', 'limits.mjs');
const localCli = (home, ...args) => {
  const r = spawnSync('node', [path.join(SCRIPTS, 'deliver.mjs'), 'config', ...args, '--local', '--dir', home], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const localRun = async (home, sub, answers, { args = [], opt = {}, confirm = 'y', yes } = {}) => {
  const out = [], asked = [], rest = [...answers];
  const io = { out: (t) => out.push(t), err: (t) => out.push(t), ask: async (p) => {
    asked.push(p);
    if (/^Write /.test(p)) return confirm;
    if (/Type yes to apply/.test(p) && yes !== undefined) return yes;
    return rest.length ? rest.shift() : '';
  } };
  const code = await runConfigCommand({ sub, args, opt: { local: true, ...opt }, root: home, home, tty: true, io });
  return { code, out: out.join('\n'), asked };
};
const newHome = () => path.join(tmpDir('cfg-local-'), 'fh');

test('classifier is fixtures only in this build (the unavailable tests below assume it)', () => assert.notEqual(L.CLASSIFIER_STATUS, 'real'));

test('explain --local wait_for_reset says it is unavailable and why; --list marks it', () => {
  const h = newHome();
  const r = localCli(h, 'explain', 'wait_for_reset');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /unavailable/i); assert.match(r.out, /fixtures only/);
  const list = localCli(h, 'explain', '--list').out.split('\n').find((l) => l.includes('wait_for_reset'));
  assert.match(list, /unavailable/);
  assert.doesNotMatch(localCli(h, 'explain', 'keep_awake').out, /unavailable/);
});

test('set --local: max_wait_h writes 0600; wait_for_reset true is refused with the parser text and writes nothing', () => {
  const h = newHome();
  assert.equal(localCli(h, 'set', 'max_wait_h', '3').code, 0);
  const f = path.join(h, 'config.json');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const before = fs.readFileSync(f);
  const r = localCli(h, 'set', 'wait_for_reset', 'true');
  assert.equal(r.code, 1); assert.match(r.err, /fixtures only/);
  assert.deepEqual(fs.readFileSync(f), before);
});

test('edit --local walks only local keys, skips wait_for_reset with one line, accepts fractional hours, writes 0600', async () => {
  const h = newHome();
  fs.mkdirSync(h, { recursive: true });
  const f = path.join(h, 'config.json');
  fs.writeFileSync(f, '{\n  "keep_awake": true\n}\n');
  const r = await localRun(h, 'edit', ['3', '0.5']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /wait_for_reset is unavailable: .*fixtures only/);
  assert.equal(r.out.match(/unavailable/g).length, 1);
  assert.doesNotMatch(r.out, /^wait_for_reset {3}\(current/m);
  for (const k of ['max_wait_h', 'max_wait_weekly_h', 'keep_awake', 'fallback_model', 'budgets.day_tokens']) assert.match(r.out, new RegExp(`^${k.replace('.', '\\.')}   \\(current`, 'm'), k);
  for (const k of ['base', 'autonomy.level', 'app.start']) assert.doesNotMatch(r.out, new RegExp(`^${k.replace('.', '\\.')}\\b`, 'm'), k);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { keep_awake: true, max_wait_h: 3, max_wait_weekly_h: 0.5 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.match(r.out, /nothing to commit/);
});

test('edit --local wait_for_reset (named) is refused as unavailable; init --local refuses an existing file naming edit --local', async () => {
  const h = newHome();
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 'config.json'), '{}\n');
  const named = await localRun(h, 'edit', [], { args: ['wait_for_reset'] });
  assert.equal(named.code, 1); assert.match(named.out, /unavailable/); assert.equal(named.asked.length, 0);
  const init = await localRun(h, 'init', []);
  assert.equal(init.code, 1); assert.match(init.out, /edit --local/);
});

test('init --local creates the folder and a 0600 file; --from-draft works for local', async () => {
  const h = newHome();
  const draft = path.join(tmpDir('cfg-draft-'), 'd.json');
  fs.writeFileSync(draft, JSON.stringify({ max_wait_h: 2, fallback_model: 'm1' }));
  const r = await localRun(h, 'init', [], { opt: { 'from-draft': draft } });
  assert.equal(r.code, 0, r.out);
  const f = path.join(h, 'config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { max_wait_h: 2, fallback_model: 'm1' });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const bad = path.join(path.dirname(draft), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ wait_for_reset: true }));
  const h2 = newHome();
  const r2 = await localRun(h2, 'init', ['q'], { opt: { 'from-draft': bad } });
  assert.equal(fs.existsSync(path.join(h2, 'config.json')), false);
  assert.match(r2.out, /fixtures only/);
});

test('edit --local: raising or unsetting budgets.day_tokens needs a typed yes; lowering does not', async () => {
  const h = newHome();
  fs.mkdirSync(h, { recursive: true });
  const f = path.join(h, 'config.json');
  const seed = () => fs.writeFileSync(f, `${JSON.stringify({ budgets: { day_tokens: 20000000 } }, null, 2)}\n`);
  seed();
  const before = fs.readFileSync(f);
  const refused = await localRun(h, 'edit', ['30000000'], { args: ['budgets.day_tokens'], yes: 'no' });
  assert.equal(refused.code, 0); assert.match(refused.out, /raises the budgets\.day_tokens cap/); assert.match(refused.out, /kept the old value/);
  assert.deepEqual(fs.readFileSync(f), before);
  const unset = await localRun(h, 'edit', ['-'], { args: ['budgets.day_tokens'], yes: 'no' });
  assert.equal(unset.code, 0); assert.match(unset.out, /kept the old value/); assert.deepEqual(fs.readFileSync(f), before);
  const ok = await localRun(h, 'edit', ['30000000'], { args: ['budgets.day_tokens'], yes: 'yes' });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).budgets.day_tokens, 30000000);
  const lower = await localRun(h, 'edit', ['10000000'], { args: ['budgets.day_tokens'], yes: 'no' });
  assert.equal(lower.code, 0, lower.out);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).budgets.day_tokens, 10000000);
});

test('a symlinked <home>/config.json is refused on read and write (set and edit)', async () => {
  const h = newHome();
  fs.mkdirSync(h, { recursive: true });
  const target = path.join(tmpDir('cfg-target-'), 'real.json');
  fs.writeFileSync(target, '{}\n');
  fs.symlinkSync(target, path.join(h, 'config.json'));
  const s = localCli(h, 'set', 'max_wait_h', '2');
  assert.equal(s.code, 1); assert.match(s.err, /symlink/);
  const e = await localRun(h, 'edit', ['2']);
  assert.equal(e.code, 1); assert.match(e.out, /symlink/);
  const i = await localRun(h, 'init', ['2']);
  assert.equal(i.code, 1); assert.match(i.out, /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), '{}\n');
});

// ---- hardening: local config ---------------------------------------------------------------------------------------------
test('init --local --from-draft with wait_for_reset: true reaches the Write prompt, y exits 1 and no file is created', async () => {
  const h = newHome();
  const draft = path.join(tmpDir('cfg-draft-'), 'd.json');
  fs.writeFileSync(draft, JSON.stringify({ wait_for_reset: true }));
  const r = await localRun(h, 'init', [], { opt: { 'from-draft': draft }, confirm: 'y' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fixtures only/);
  assert.equal(fs.existsSync(path.join(h, 'config.json')), false);
});

test('a symlinked FACTORY_HOME folder is refused by set --local and edit --local, and nothing is written through it', async () => {
  const real = path.join(tmpDir('cfg-real-'), 'real');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(tmpDir('cfg-link-'), 'fh');
  fs.symlinkSync(real, link);
  const s = localCli(link, 'set', 'max_wait_h', '2');
  assert.equal(s.code, 1); assert.match(s.err, /symlink/);
  const e = await localRun(link, 'edit', ['2']);
  assert.equal(e.code, 1);
  assert.equal(fs.existsSync(path.join(real, 'config.json')), false); // (the CLI's own .skill-runs log may appear; the config may not)
});
