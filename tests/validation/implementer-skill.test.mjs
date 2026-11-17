import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const DIR = path.join(REPO, 'skills/implementer');
const lines = (p) => fs.readFileSync(p, 'utf8').split('\n').length;

test('AC7 size caps hold, every role has a file, every linked file exists', () => {
  const skill = path.join(DIR, 'SKILL.md');
  const text = fs.readFileSync(skill, 'utf8');
  assert.match(text, /^name: implementer$/m);
  assert.ok(lines(skill) <= 150, `SKILL.md has ${lines(skill)} lines`);
  const roles = JSON.parse(fs.readFileSync(path.join(DIR, 'core/roles/roles.json'), 'utf8')).roles;
  for (const r of roles) {
    const f = path.join(DIR, 'core/roles', `${r.name}.md`);
    assert.ok(fs.existsSync(f), `missing role file ${r.name}`);
    assert.ok(lines(f) <= 40, `${r.name}.md has ${lines(f)} lines`);
  }
  const links = [...text.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
  assert.ok(links.length > 0);
  for (const l of links) assert.ok(fs.existsSync(path.join(DIR, l)), `broken link ${l}`);
});

test('AC8 close-out write-back (delivery key + Delivery log row) keeps a product spec valid', async () => {
  const { projectFrom, validateJson, edit } = await import('./helpers.mjs');
  const dir = projectFrom('a');
  const before = validateJson(dir).errors.length;
  edit(dir, '.product/features/FEATURE-001.md', (t) =>
    t.replace(/^status: draft$|^status: ready$/m, (m) => `${m}\ndelivery: partial`) +
    '\n## Delivery log\n| Date | Branch / PR | Delivered | Pending (code) | Pending (non-code) | Notes |\n|---|---|---|---|---|---|\n| 2026-11-17 | feat/x | AC-1 | AC-2 | owner review | wave 1 |\n');
  assert.equal(validateJson(dir).errors.length, before);
});
