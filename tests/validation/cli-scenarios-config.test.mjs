// app.cli: the command the factory runs to verify a CLI. Parser and command checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const { parseConfig, cliCommandProblem } = await import(path.join(LIB, 'config.mjs'));
const { SCHEMA } = await import(path.join(LIB, 'configschema.mjs'));
const withCli = (cli) => parseConfig({ app: { cli } });

test('app.cli absent parses to null', () => {
  const r = parseConfig({});
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.app.cli, null);
});

test('app.cli with a command gets the default timeout', () => {
  const r = withCli({ command: ['node', './src/cli.ts'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.config.app.cli, { command: ['node', './src/cli.ts'], timeout_s: 30 });
  assert.equal(withCli({ command: ['seo'], timeout_s: 120 }).config.app.cli.timeout_s, 120);
  assert.equal(withCli({ command: ['seo'], timeout_s: 1 }).config.app.cli.timeout_s, 1);
});

test('app.cli refuses malformed values, naming app.cli', () => {
  const bad = [
    'node ./cli.js', [], { command: 'node ./cli.js' }, { command: [] },
    { command: Array.from({ length: 11 }, (_, i) => `a${i}`) }, { command: ['node', 5] }, { command: ['node', ''] },
    { command: ['node'], timeout_s: 0 }, { command: ['node'], timeout_s: 121 }, { command: ['node'], timeout_s: 1.5 },
    { command: ['node'], extra: 1 }, {},
    { command: ['/usr/bin/node'] }, { command: ['node', '../x'] },
  ];
  for (const b of bad) {
    const r = withCli(b);
    assert.ok(r.errors.some((m) => m.includes('app.cli')), JSON.stringify(b));
  }
  assert.deepEqual(withCli({ command: Array.from({ length: 10 }, (_, i) => `a${i}`) }).errors, []);
});

test('cliCommandProblem', () => {
  for (const c of [['/usr/bin/node'], ['node', '../x'], ['node', './a/../../x'], ['node', 'a/../b'], ['node', './a/../b.js'], ['node', 'a\\..\\b'], ['node', 'x\0y'], ['node', 'x\ny'], ['node', '/etc/passwd']]) {
    assert.equal(typeof cliCommandProblem(c), 'string', JSON.stringify(c));
  }
  for (const c of [['node', './src/cli.ts'], ['pnpm', 'exec', 'seo'], ['node', './a.b/c..d']]) assert.equal(cliCommandProblem(c), null, JSON.stringify(c));
});

test('app.cli is a sensitive project key', () => {
  const e = SCHEMA.find((x) => x.path === 'app.cli');
  assert.ok(e);
  assert.equal(e.sensitive, true);
  assert.deepEqual(e.readBy, ['deliver readiness', 'factory run']);
});
