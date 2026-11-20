// Every skill's install-agents.mjs must run when reached through a symlinked path (for example a skills folder
// symlinked by `npx skills add`, or macOS /var -> /private/var). A main guard comparing unresolved paths silently did nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SKILLS = fs.readdirSync(path.join(REPO, 'skills')).filter((s) => fs.existsSync(path.join(REPO, 'skills', s, 'core/scripts/install-agents.mjs')));

test('every skill with native agents is covered', () => {
  assert.deepEqual([...SKILLS].sort(), ['experience-audit', 'growth-strategy', 'implementer', 'product-intelligence']);
});

for (const skill of SKILLS) {
  test(`${skill}: install-agents runs when invoked through a symlinked skills folder`, () => {
    const real = tmpDir('ia-real-');
    fs.cpSync(path.join(REPO, 'skills', skill), path.join(real, skill), { recursive: true });
    const link = path.join(tmpDir('ia-link-'), 'skills');
    fs.symlinkSync(real, link);
    const proj = tmpDir('ia-proj-');
    const args = [path.join(link, skill, 'core/scripts/install-agents.mjs'), '--scope', 'project', '--project-dir', proj];
    if (['product-intelligence', 'growth-strategy'].includes(skill)) args.push('--agent', 'claude-code');
    const r = spawnSync('node', args, { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const written = fs.existsSync(path.join(proj, '.claude/agents')) ? fs.readdirSync(path.join(proj, '.claude/agents')) : [];
    assert.ok(written.length > 0, `no agents written; stdout: ${JSON.stringify(r.stdout)}`);
  });
}
