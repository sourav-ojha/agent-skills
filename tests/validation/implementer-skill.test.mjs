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
