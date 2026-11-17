import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { renderClaude } from '../../skills/implementer/core/scripts/install-agents.mjs';

const CORE = path.join(REPO, 'skills/implementer/core');
const roles = JSON.parse(fs.readFileSync(path.join(CORE, 'roles/roles.json'), 'utf8')).roles;
const config = JSON.parse(fs.readFileSync(path.join(CORE, 'config.default.json'), 'utf8'));

test('AC6 agent files: tools from capabilities, model alias from tier, one per role', () => {
  const reviewer = roles.find((r) => r.name === 'reviewer');
  const engineer = roles.find((r) => r.name === 'software-engineer');
  const rv = renderClaude(reviewer, config);
  assert.match(rv, /^name: impl-reviewer$/m);
  assert.match(rv, /^model: opus$/m);
  assert.doesNotMatch(rv, /^tools:.*(Edit|Write|Bash)/m); // reviewer is read-only
  assert.match(renderClaude(engineer, config), /^tools:.*Edit.*Bash|^tools:.*Bash.*Edit/m);

  const dir = tmpDir('impl-agents-');
  const r = spawnSync('node', [path.join(CORE, 'scripts/install-agents.mjs'), '--scope', 'project', '--project-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const written = fs.readdirSync(path.join(dir, '.claude/agents')).sort();
  assert.deepEqual(written, roles.map((x) => `impl-${x.name}.md`).sort());
});

test('AC6 unsafe model name is rejected', () => {
  const evil = { models: { 'claude-code': { reasoning: 'opus\ntools: Bash', standard: 'sonnet', fast: 'haiku' } } };
  assert.throws(() => renderClaude(roles.find((r) => r.name === 'reviewer'), evil), /invalid model/i);
});
