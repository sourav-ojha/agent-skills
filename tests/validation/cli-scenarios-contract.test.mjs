// `## CLI contract` in the spec: extraction, matching, hash coverage, and feature-intake's mixed-contract warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const cr = await import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'criteria.mjs'));

const spec = (cliBlock, httpBlock = '') => `---
id: FEATURE-001
status: draft
---

# Seo

## 10. Acceptance criteria

| ID | Covers | Criterion |
|---|---|---|
| AC-1 | FR-1 | **Given** a site **When** about **Then** json |

## 11. Edge cases

- EC-1: none given prints help

${httpBlock}${cliBlock}
## 13. Security and privacy considerations

Nothing.
`;
const CLI = '## CLI contract\n\n- `seo about`\n- `seo about --json`\n\n';

test('extractCriteria: CLI contract patterns drop the display name', () => {
  const c = cr.extractCriteria(spec(CLI));
  assert.deepEqual(c.errors, []);
  assert.deepEqual(c.cliContract, [{ words: ['about'] }, { words: ['about', '--json'] }]);
  assert.deepEqual(cr.extractCriteria(spec('## CLI contract\n\n- `seo`\n\n')).cliContract, [{ words: [] }]);
  assert.deepEqual(cr.extractCriteria(spec('')).cliContract, []);
});

test('extractCriteria: malformed CLI contract sections are errors naming the CLI contract', () => {
  for (const block of ['## CLI contract\n\n- seo about\n\n', '## CLI contract\n\n', '## CLI contract\n\n- `{{command}}`\n\n']) {
    const c = cr.extractCriteria(spec(block));
    assert.equal(c.ok, false, block);
    assert.ok(c.errors.some((e) => e.includes('CLI contract')), `${block}: ${c.errors.join(' | ')}`);
  }
});

test('extractCriteria: a hostile CLI contract cannot hang the parser', () => {
  const t0 = Date.now();
  const c = cr.extractCriteria(spec(`## CLI contract\n\n- \`${'a '.repeat(20000)}\`\n${'- `seo x`\n'.repeat(5000)}\n`));
  assert.equal(c.ok, false);
  assert.ok(Date.now() - t0 < 5000);
});

test('matchCliContract', () => {
  const m = (words, args) => cr.matchCliContract([{ words }], args);
  assert.equal(m(['about'], ['about']), true);
  assert.equal(m(['about'], ['about', 'x']), false);
  assert.equal(m(['about', '--json'], ['about']), false);
  assert.equal(m(['about'], []), false);
  assert.equal(m([], []), true);
  assert.equal(m([], ['x']), false);
  assert.equal(m(['show', '<name>'], ['show', 'x']), true);
  assert.equal(m(['show', '<name>'], ['show', '']), false);
  assert.equal(m(['show', '<name>'], ['show']), false);
  assert.equal(m(['show', '<name>'], ['show', 'a', 'b']), false);
  assert.equal(m(['run', '...'], ['run']), true);
  assert.equal(m(['run', '...'], ['run', 'a', 'b']), true);
  assert.equal(m(['run', '...'], []), false);
  assert.equal(cr.matchCliContract([{ words: ['a'] }, { words: ['b'] }], ['b']), true);
  assert.equal(cr.matchCliContract([], ['b']), false);
});

test('changing one CLI contract line changes criteriaHash', () => {
  const h = (t) => cr.criteriaHash(cr.extractCriteria(t).sections);
  assert.notEqual(h(spec(CLI)), h(spec(CLI.replace('about --json', 'about --yaml'))));
  assert.notEqual(h(spec(CLI)), h(spec('')));
});

test('feature-intake check passes a spec with both contracts but warns', () => {
  const FI = path.join(REPO, 'skills', 'feature-intake', 'core', 'scripts', 'fi.mjs');
  const run = (dir, args) => spawnSync('node', [FI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, SKILL_RUNLOG: '' } });
  const base = fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'intake', 'valid-minimal.md'), 'utf8').replace(/^status: ready$/m, 'status: draft');
  const withBlocks = (extra) => {
    const dir = tmpDir('fi-cli-');
    fs.mkdirSync(path.join(dir, '.product', 'features'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.product', 'features', 'FEATURE-001.md'), base.replace(/^## 9\./m, `${extra}## 9.`));
    return dir;
  };
  const both = run(withBlocks(CLI), ['check', 'FEATURE-001']);
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.match(both.stdout, /both an HTTP contract and a CLI contract/);
  const noHttp = (dir) => { const f = path.join(dir, '.product', 'features', 'FEATURE-001.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/## HTTP contract[\s\S]*?(?=## CLI contract)/, '')); return dir; };
  const only = run(noHttp(withBlocks(CLI)), ['check', 'FEATURE-001']);
  assert.equal(only.status, 0, only.stdout + only.stderr);
  assert.doesNotMatch(only.stdout, /both an HTTP contract/);
});
