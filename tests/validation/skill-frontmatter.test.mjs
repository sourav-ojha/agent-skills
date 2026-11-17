// The `skills` CLI skips a SKILL.md whose frontmatter is not strict YAML (e.g. an unquoted ": " inside a value).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const root = path.join(REPO, 'skills');

for (const name of fs.readdirSync(root)) {
  const file = path.join(root, name, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  test(`${name}: SKILL.md frontmatter is installable YAML`, () => {
    const m = fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, 'frontmatter block missing');
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z][\w-]*):\s+(.*)$/); // top-level scalars only
      if (!kv) continue;
      const v = kv[2];
      if (/^["'[{|>]/.test(v)) continue; // quoted, flow or block scalar
      assert.ok(!/: |\s#/.test(v), `${kv[1]}: unquoted value contains ": " or " #" (quote it): ${v.slice(0, 60)}`);
    }
  });
}
