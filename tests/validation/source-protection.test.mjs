import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectFrom, pi, tmpDir } from './helpers.mjs';

test('snapshot/verify-clean: .product writes are allowed, application edits are caught', () => {
  const dir = projectFrom('a');
  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.appendFileSync(path.join(dir, '.product/PRODUCT.md'), '\n');
  assert.equal(pi(dir, ['verify-clean']).code, 0);

  fs.appendFileSync(path.join(dir, 'src/app.js'), '\n// sneaky edit\n');
  const modified = pi(dir, ['verify-clean']);
  assert.equal(modified.code, 2);
  assert.deepEqual(JSON.parse(modified.out).modified, ['src/app.js']);

  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.writeFileSync(path.join(dir, 'src/new.js'), 'x');
  fs.rmSync(path.join(dir, 'index.html'));
  const r = JSON.parse(pi(dir, ['verify-clean']).out);
  assert.deepEqual([r.added, r.removed], [['src/new.js'], ['index.html']]);
});

test('snapshot works in git repos and ignores untracked .product', () => {
  const dir = projectFrom('b');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.writeFileSync(path.join(dir, '.product/extra.md'), 'x');
  assert.equal(pi(dir, ['verify-clean']).code, 0);
  fs.appendFileSync(path.join(dir, 'README.md'), 'edit');
  assert.equal(pi(dir, ['verify-clean']).code, 2);
});

test('verify-clean without a snapshot fails loudly', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  assert.notEqual(pi(dir, ['verify-clean', '--tag', 'never-made']).code, 0);
});

test('the skill never writes outside .product during gate commands', () => {
  const dir = projectFrom('a');
  pi(dir, ['snapshot']);
  pi(dir, ['reopen-product', '--by', 'Ann']);
  pi(dir, ['approve-product', '--by', 'Ann']);
  pi(dir, ['status']);
  pi(dir, ['validate']);
  assert.equal(pi(dir, ['verify-clean']).code, 0);
});
