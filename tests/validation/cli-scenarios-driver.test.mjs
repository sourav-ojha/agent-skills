// `cli` scenarios in the driver: the `unverifiable` early warning in `factory scenarios`, the start refusal in `factory run`, the
// author prompt's cli shape and kind choice, and the failed-family word reaching the fix brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, readiness, fspec, BASE_CONFIG, AUTHOR_OK, good, builderRuns, promptOf } from './factory-world.mjs';

const CLI_CONFIG = { ...BASE_CONFIG, app: { cli: { command: ['node', './cli.mjs'], timeout_s: 10 } } };
const cliSpec = (id, title) => fspec(id, title).replace(/## HTTP contract[\s\S]*$/, '## CLI contract\n\n- `seo about`\n- `seo about --json`\n');
const bothSpec = (id, title) => `${cliSpec(id, title)}\n## HTTP contract\n\n- \`GET /api/items\`\n- \`POST /api/items\`\n`;
const cliReply = JSON.stringify({ scenarios: [
  { id: 'S-1', covers: ['AC-1'], kind: 'cli', setup: { files: [{ path: 'in.txt', text: 'cli-hidden-xyz fx-000000' }] }, run: { args: ['about', '--json'] }, assert: [{ exit: 0 }, { stdout: { contains: 'cli-expected-value' } }] },
  { id: 'S-2', covers: ['EC-1'], kind: 'cli', run: { args: ['about'] }, assert: [{ exit: 0 }] },
] });
const uiReply = JSON.stringify({ scenarios: [
  { id: 'S-1', covers: ['AC-1'], kind: 'ui', setup: ['fx-000000'], steps: ['open'], expect: ['see'] },
  { id: 'S-2', covers: ['EC-1'], kind: 'ui', steps: ['open'], expect: ['see'] },
] });

function put(w, files) {
  for (const [id, text] of Object.entries(files)) fs.writeFileSync(path.join(w.work, `.product/features/${id}.md`), text);
  w.sh(w.work, 'add', '-A'); w.sh(w.work, 'commit', '-q', '-m', 'specs'); w.sh(w.work, 'push', '-q', 'origin', 'main');
}
const CANARY_FIX = (reply) => reply.replace(/fx-000000/g, '{{CANARY}}');

test('factory scenarios: cli scenarios with app.cli set are stored and not unverifiable', (t) => {
  const w = world(t, { config: CLI_CONFIG, specs: { 'FEATURE-001': 'One' }, fake: { author: { 'FEATURE-001': CANARY_FIX(cliReply) } } });
  put(w, { 'FEATURE-001': cliSpec('FEATURE-001', 'One') }); readiness(w);
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored \(2\), approved: auto\n/);
  assert.ok(!/unverifiable/.test(r.out), r.out);
  assert.match(r.out, /scenarios: stored 1, current 0, awaiting_approval 0, invalid 0, criteria_errors 0, failed 0$/m);
});

test('factory scenarios: cli scenarios without app.cli are stored as unverifiable (needs app.cli); factory run refuses', (t) => {
  const w = world(t, { config: BASE_CONFIG, specs: { 'FEATURE-001': 'One' }, fake: { author: { 'FEATURE-001': CANARY_FIX(cliReply) } } });
  put(w, { 'FEATURE-001': cliSpec('FEATURE-001', 'One') }); readiness(w);
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored \(2\), approved: auto, unverifiable \(needs app\.cli\)\n/);
  assert.match(r.out, /scenarios: stored 1, .*failed 0, unverifiable 1$/m);
  const again = w.factory(['scenarios']);
  assert.match(again.out, /FEATURE-001 scenarios: current and approved, unverifiable \(needs app\.cli\)/);
  const run = w.factory(['run']);
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.out + run.err, /refused: FEATURE-001 has scenarios the verifier cannot run \(needs app\.cli\)/);
  assert.match(run.out + run.err, /fix: set app\.cli in \.product\/delivery\.json on the base branch/);
  assert.equal(w.sessions().filter((s) => !s.argv.includes('--tools')).length, 0, 'no builder session started');
});

test('factory scenarios: ui scenarios are stored unverifiable (ui scenarios); factory run refuses them and --only runs the other feature', (t) => {
  const w = world(t, { config: CLI_CONFIG, fake: { author: { 'FEATURE-001': CANARY_FIX(uiReply), 'FEATURE-002': AUTHOR_OK } } });
  readiness(w);
  const s = w.factory(['scenarios']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /FEATURE-001 scenarios: stored \(2\), approved: auto, unverifiable \(ui scenarios\)/);
  assert.match(s.out, /FEATURE-002 scenarios: stored \(2\), approved: auto, unverifiable \(needs app\.start\)/); // api set, config has only app.cli
  const run = w.factory(['run']);
  assert.equal(run.code, 1, run.out + run.err);
  assert.match(run.out + run.err, /refused: FEATURE-001 has scenarios the verifier cannot run \(ui scenarios\)/);
  assert.match(run.out + run.err, /fix: UI scenarios need Phase 1b; re-author the feature's scenarios as api or cli/);
  assert.equal(w.sessions().filter((x) => !x.argv.includes('--tools')).length, 0);
});

test('factory run --only starts a feature with verifiable scenarios while another is unverifiable', (t) => {
  const cfg = { ...BASE_CONFIG, app: { start: ['node', 'x.mjs'], base_url: 'http://127.0.0.1:3000', ready: { url: 'http://127.0.0.1:3000/' } } };
  const w = world(t, { config: cfg, fake: { author: { 'FEATURE-001': CANARY_FIX(uiReply), 'FEATURE-002': AUTHOR_OK }, plan: { 'FEATURE-002': [good('FEATURE-002')] } } });
  readiness(w);
  const s = w.factory(['scenarios']);
  assert.match(s.out, /FEATURE-001 scenarios: stored \(2\), approved: auto, unverifiable \(ui scenarios\)/);
  assert.ok(!/FEATURE-002 scenarios: .*unverifiable/.test(s.out), s.out);
  const run = w.factory(['run', '--only', 'FEATURE-002']);
  assert.ok(!/cannot run/.test(run.out + run.err), run.out + run.err);
  assert.equal(builderRuns(w, 'FEATURE-002').length > 0, true, run.out + run.err);
});

test('factory scenarios: a spec with both contracts is stored unverifiable (mixed contracts) with api scenarios', (t) => {
  const w = world(t, { config: { ...CLI_CONFIG, app: { ...CLI_CONFIG.app, start: ['node', 'x.mjs'], base_url: 'http://127.0.0.1:3000', ready: { url: 'http://127.0.0.1:3000/' } } }, specs: { 'FEATURE-001': 'One' } });
  put(w, { 'FEATURE-001': bothSpec('FEATURE-001', 'One') }); readiness(w);
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored \(2\), approved: auto, unverifiable \(mixed contracts\)/);
  const run = w.factory(['run']);
  assert.equal(run.code, 1);
  assert.match(run.out + run.err, /refused: FEATURE-001 has scenarios the verifier cannot run \(mixed contracts\)/);
  assert.match(run.out + run.err, /fix: a feature's scenarios must be all api or all cli; give the spec one contract and re-author/);
});

test('the author prompt has the cli shape, the kind choice, and the spec CLI contract', (t) => {
  const w = world(t, { config: CLI_CONFIG, specs: { 'FEATURE-001': 'One' }, fake: { author: { 'FEATURE-001': CANARY_FIX(cliReply) } } });
  put(w, { 'FEATURE-001': cliSpec('FEATURE-001', 'One') }); readiness(w);
  w.factory(['scenarios']);
  const author = w.sessions().find((s) => s.argv.includes('--tools'));
  assert.ok(author, 'an author session ran');
  const p = promptOf(author);
  assert.match(p, /"kind": "cli"/);
  assert.match(p, /"run": \{"args"/);
  assert.match(p, /Use `cli` when the spec has a CLI contract and no HTTP contract/);
  assert.match(p, /Use `api` when the spec has an HTTP contract \(also when it has both contracts\)/);
  assert.match(p, /Use `ui` only when the spec has neither contract/);
  assert.match(p, /### CLI contract \(arguments after the program name\)\n- `about`\n- `about --json`/);
  assert.match(p, /### HTTP contract\n\(none\)/);
});

test('a failing cli verification puts only the family word in the fix brief', (t) => {
  const w = world(t, { config: CLI_CONFIG, specs: { 'FEATURE-001': 'One' }, fake: { author: { 'FEATURE-001': CANARY_FIX(cliReply) },
    plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), files: { 'src/FEATURE-001.txt': 'wrong\n' } }, { files: { 'src/FEATURE-001.txt': 'good\n' }, commit: true }] } },
  test: { verify: { family: 'stdout' } } });
  put(w, { 'FEATURE-001': cliSpec('FEATURE-001', 'One') }); readiness(w);
  assert.equal(w.factory(['scenarios']).code, 0);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2);
  const brief = [promptOf(runs[1]), fs.readFileSync(path.join(w.builder, '.implementation', 'FEATURE-001', 'fix-brief.md'), 'utf8')];
  for (const s of brief) {
    assert.match(s, /AC-1: a command exited, printed or wrote something unexpected \(stdout\)/);
    assert.match(s, /EC-1: a command exited, printed or wrote something unexpected \(stdout\)/);
    for (const x of ['about', '--json', 'cli-expected-value', 'cli-hidden-xyz', 'in.txt', 'S-1', 'S-2']) assert.ok(!s.includes(x), `the fix brief leaks ${x}`);
  }
  assert.ok(!fs.readdirSync(path.join(w.fhome, 'verdicts', 'o__r')).some((f) => /famil/.test(fs.readFileSync(path.join(w.fhome, 'verdicts', 'o__r', f), 'utf8'))), 'families never stored');
});

test('factory scenarios: a stored set awaiting approval still carries the unverifiable tag on later runs', (t) => {
  const w = world(t, { config: { ...BASE_CONFIG, verification: { required: true, scenario_approval: 'human' } }, specs: { 'FEATURE-001': 'One' }, fake: { author: { 'FEATURE-001': CANARY_FIX(cliReply) } } });
  put(w, { 'FEATURE-001': cliSpec('FEATURE-001', 'One') }); readiness(w);
  const first = w.factory(['scenarios']);
  assert.match(first.out, /awaiting approval \(factory scenarios --approve FEATURE-001 --by <name>\), unverifiable \(needs app\.cli\)/, first.out);
  const again = w.factory(['scenarios']);
  assert.match(again.out, /FEATURE-001 scenarios: current, awaiting approval \(factory scenarios --approve FEATURE-001 --by <name>\), unverifiable \(needs app\.cli\)/, again.out);
  assert.match(again.out, /unverifiable 1$/m);
});
