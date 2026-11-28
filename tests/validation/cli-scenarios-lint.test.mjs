// Lint for `cli` scenarios: shape, contract binding, limits, assertions, canary.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const lib = (f) => import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', f));
const sc = await lib('scenarios.mjs');
const vf = await lib('verify.mjs');

const crit = (cli = [{ words: ['about'] }, { words: ['about', '--json'] }], contract = []) => ({
  ok: true, errors: [], ac: [{ id: 'AC-1' }], ec: [], er: [], contract, cliContract: cli,
});
const HASH = 'sha256:abc';
const CANARY = 'fx-abc123';
const cli = (o = {}) => ({
  id: 'S-1', covers: ['AC-1'], kind: 'cli',
  run: { args: ['about', '--json'] },
  assert: [{ exit: 0 }, { stdout: { json_path: '$.name', equals: CANARY } }],
  ...o,
});
const lint = (scenarios, criteria = crit()) => sc.lintScenarios({ criteria_hash: HASH, canary: CANARY, scenarios }, criteria, HASH);
const refused = (s, criteria) => {
  const r = lint([s], criteria);
  assert.equal(r.ok, false, JSON.stringify(s));
  assert.ok(r.problems.some((p) => p.includes('S-1')), `label in: ${r.problems}`);
  return r;
};

test('valid cli scenario lints clean; canary in run.args, setup file text, assertion value or stdin', () => {
  assert.deepEqual(lint([cli()]), { ok: true, problems: [] });
  const full = cli({
    setup: { files: [{ path: 'sites/x.yaml', text: 'a' }], runs: [{ args: ['about'], stdin: 'x' }] },
    run: { args: ['about', '--json'], stdin: '' },
    assert: [{ exit: 0 }, { stderr: { equals: '' } }, { file: 'seo.config.yaml', exists: true }, { file: 'out/r.json', json_path: '$.items', count: 3 },
      { stdout: { contains: CANARY } }, { stdout: { not_contains: 'x' } }, { file: 'a.txt', matches: '^a' }],
  });
  assert.deepEqual(lint([full]), { ok: true, problems: [] });
  const noCanaryAssert = [{ exit: 0 }];
  assert.equal(lint([cli({ assert: noCanaryAssert })]).ok, false, 'canary absent');
  const where = [
    { run: { args: ['about'], stdin: CANARY } },
    { setup: { files: [{ path: 'a', text: CANARY }] } },
  ];
  for (const w of where) assert.deepEqual(lint([cli({ assert: noCanaryAssert, ...w })]), { ok: true, problems: [] });
  const c2 = crit([{ words: ['about', '<x>'] }]);
  assert.deepEqual(lint([cli({ assert: noCanaryAssert, run: { args: ['about', CANARY] } })], c2), { ok: true, problems: [] });
});

test('api and cli scenarios in one set each lint on their own rules', () => {
  const api = { id: 'S-2', covers: ['AC-1'], kind: 'api', request: { method: 'GET', path: '/api/p' }, assert: [{ status: 200 }] };
  const r = lint([cli(), api], crit(undefined, [{ method: 'GET', path: '/api/p' }]));
  assert.deepEqual(r, { ok: true, problems: [] });
});

test('structural refusals', () => {
  const { run: _r, ...noRun } = cli();
  refused(noRun);
  refused(cli({ assert: [] }));
  refused(cli({ assert: [{ stdout: { equals: CANARY } }] }));
  refused(cli({ assert: [{ exit: 256 }] }));
  refused(cli({ assert: [{ exit: -1 }, { stdout: { equals: CANARY } }] }));
  refused(cli({ run: { args: ['init'] } }));
  refused(cli(), crit([]));
  refused(cli({ run: { args: ['about', ''] } }), crit([{ words: ['about', '<x>'] }]));
  refused(cli({ run: { args: ['about', 'a'] } }), crit([{ words: ['about'] }]));
  assert.equal(lint([cli()], crit([])).ok, false);
});

test('limits', () => {
  const ok = Array(64).fill('x');
  const open = crit([{ words: ['...'] }]);
  assert.equal(lint([cli({ run: { args: ok } })], open).ok, true);
  refused(cli({ run: { args: Array(65).fill('x') } }), open);
  refused(cli({ run: { args: ['x'.repeat(4097)] } }), open);
  refused(cli({ run: { args: ['a\0b'] } }), open);
  refused(cli({ run: { args: ['about'], stdin: 'x'.repeat(64 * 1024 + 1) } }));
  for (const p of ['../x', '/etc/passwd', 'a\\b', 'a/../b', 'a\0b', 'x'.repeat(257)]) refused(cli({ setup: { files: [{ path: p, text: '' }] } }));
  refused(cli({ setup: { files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, text: '' })) } }));
  refused(cli({ setup: { files: [{ path: 'a', text: 'x'.repeat(256 * 1024 + 1) }] } }));
  refused(cli({ setup: { runs: [{ args: ['init'] }] } }));
  refused(cli({ setup: { runs: Array.from({ length: 11 }, () => ({ args: ['about'] })) } }));
  refused(cli({ assert: [{ exit: 0 }, ...Array.from({ length: 100 }, () => ({ stdout: { contains: CANARY } }))] }));
});

test('assertion shapes', () => {
  const bad = [
    { foo: 1 }, { exit: '0' }, { exit: 0, extra: 1 }, { stdout: {} }, { stdout: 'x' }, { stdout: { equals: 1 } },
    { stdout: { contains: '' } }, { stdout: { matches: '' } }, { stdout: { matches: '(' } }, { stdout: { matches: 'a'.repeat(257) } },
    { stdout: { json_path: '$.a', equals: 'x', contains: 'y' } }, 
    { stdout: { equals: 'x', contains: 'y' } }, { stdout: { json_path: '$.a' } },
    { stdout: { json_path: '$.a', contains: '' } }, { stdout: { json_path: '$.a', matches: '' } },
    { file: '../x', exists: true }, { file: '/x', exists: true }, { file: 'a', exists: 'yes' }, { file: 'a' },
    { file: 'a', exists: true, equals: 'x' }, { file: 'a', contains: '' }, { stdout: { equals: 'x' }, stderr: { equals: '' } },
  ];
  for (const a of bad) assert.equal(sc.validCliAssertion(a), false, JSON.stringify(a));
  const good = [
    { exit: 0 }, { exit: 255 }, { stdout: { equals: '' } }, { stderr: { contains: 'x' } }, { stdout: { not_contains: '' } },
    { stdout: { matches: '^a+$' } }, { stdout: { json_path: '$.a', count: 2 } }, { file: 'a/b', exists: false }, { file: 'a', not_contains: 'x' },
  ];
  for (const a of good) assert.equal(sc.validCliAssertion(a), true, JSON.stringify(a));
  refused(cli({ assert: [{ exit: 0 }, { stdout: { json_path: '$.name', equals: 'x', contains: 'y' } }, { stdout: { contains: CANARY } }] }));
});

test('validRelPath and CLI_LIMITS', () => {
  for (const p of ['a', 'a/b.txt', 'out/report.json']) assert.equal(sc.validRelPath(p), true, p);
  for (const p of ['', '/a', '../a', 'a/..', 'a\\b', 'a\0', 'x'.repeat(257), 5, null]) assert.equal(sc.validRelPath(p), false, String(p));
  assert.equal(sc.validRelPath('x'.repeat(256)), true);
  assert.equal(sc.CLI_LIMITS.maxArgs, 64);
});

test('api scenario with the canary only in assert is still refused (canary extension is cli-only)', () => {
  const api = { id: 'S-1', covers: ['AC-1'], kind: 'api', request: { method: 'GET', path: '/api/p' }, assert: [{ status: 200 }, { json_path: '$.a', equals: CANARY }] };
  const r = lint([api], crit(undefined, [{ method: 'GET', path: '/api/p' }]));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('canary does not appear')));
});

test('unknown keys and wrong container types in run/setup are refused', () => {
  refused(cli({ run: { args: ['about'], argz: [] } }));
  refused(cli({ setup: { fils: [] } }));
  refused(cli({ setup: { files: [{ path: 'a', text: '', mode: 1 }] } }));
  refused(cli({ setup: { runs: [{ args: ['about'], env: {} }] } }));
  for (const v of [null, [], 'x', 5]) {
    refused(cli({ run: v }));
    refused(cli({ setup: v }));
    if (!Array.isArray(v)) { refused(cli({ setup: { files: v } })); refused(cli({ setup: { runs: v } })); }
  }
});

test('duplicate setup file paths and file/dir conflicts are refused', () => {
  refused(cli({ setup: { files: [{ path: 'a', text: '' }, { path: 'a', text: '' }] } }));
  refused(cli({ setup: { files: [{ path: 'a', text: '' }, { path: 'a/b', text: '' }] } }));
  assert.equal(lint([cli({ setup: { files: [{ path: 'a/b', text: '' }, { path: 'a/c', text: '' }, { path: 'ab', text: '' }] } })]).ok, true);
});

test('symptom-brief filter collects cli run, setup and assert strings', () => {
  const s = cli({ run: { args: ['about', 'secret-arg-value'] }, setup: { files: [{ path: 'p.txt', text: 'secret-file-text' }], runs: [{ args: ['secret-setup-arg'] }] }, assert: [{ exit: 0 }, { stdout: { equals: 'secret-expected' } }] });
  const got = vf.scenarioStrings([s], CANARY);
  for (const secret of [CANARY, 'secret-arg-value', 'secret-file-text', 'secret-setup-arg', 'secret-expected']) assert.ok(got.has(secret), secret);
});

test('lint refuses exactly what the runner refuses: json_path shapes the engine cannot parse, count not a non-negative integer', () => {
  const bad = [
    { stdout: { json_path: '$..name', equals: 'x' } }, { stdout: { json_path: '$["a"]', equals: 'x' } }, { stdout: { json_path: 'name', equals: 'x' } },
    { stdout: { json_path: '$.a', count: '3' } }, { stdout: { json_path: '$.a', count: -1 } }, { stdout: { json_path: '$.a', count: 1.5 } },
    { file: 'a.json', json_path: '$..x', equals: 'x' }, { file: 'a.json', json_path: '$.a', count: '3' },
  ];
  for (const a of bad) {
    assert.equal(sc.validCliAssertion(a), false, JSON.stringify(a));
    refused(cli({ assert: [{ exit: 0 }, a, { stdout: { contains: CANARY } }] }));
    assert.throws(() => vf.scenarioPlan({ criteria_hash: HASH, scenarios: [{ id: 'S-1', covers: ['AC-1'], kind: 'cli', run: { args: ['about'] }, assert: [{ exit: 0 }, a] }] }, HASH), /invalid cli assertions/, JSON.stringify(a));
  }
  for (const a of [{ stdout: { json_path: '$.a.b[0]', count: 0 } }, { stdout: { json_path: '$.a', equals: 'x' } }]) assert.equal(sc.validCliAssertion(a), true, JSON.stringify(a));
});

test('setup file paths are compared after normalisation and case-folding, like the runner', () => {
  refused(cli({ setup: { files: [{ path: './a', text: '' }, { path: 'a', text: '' }] } }));
  refused(cli({ setup: { files: [{ path: 'A', text: '' }, { path: 'a', text: '' }] } }));
  refused(cli({ setup: { files: [{ path: 'd//x', text: '' }, { path: 'D/x', text: '' }] } }));
  refused(cli({ setup: { files: [{ path: './a', text: '' }, { path: 'A/b', text: '' }] } }));
});

test('a file exists:true assertion on a setup-created path is refused (a do-nothing program would pass)', () => {
  const files = [{ path: 'in/a.txt', text: 'x' }];
  refused(cli({ setup: { files }, assert: [{ exit: 0 }, { file: 'in/a.txt', exists: true }, { stdout: { contains: CANARY } }] }));
  refused(cli({ setup: { files }, assert: [{ exit: 0 }, { file: './IN/a.txt', exists: true }, { stdout: { contains: CANARY } }] }));
  assert.equal(lint([cli({ setup: { files }, assert: [{ exit: 0 }, { file: 'in/a.txt', exists: false }, { file: 'out.txt', exists: true }, { stdout: { contains: CANARY } }] })]).ok, true);
});
