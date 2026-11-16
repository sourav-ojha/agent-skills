#!/usr/bin/env node
// Packages one skill folder into dist/<name>-<version>.zip (or .tar.gz when `zip` is unavailable).
// usage: node scripts/package-skill.mjs <skill-name>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!name) { console.error('usage: package-skill.mjs <skill-name>'); process.exit(1); }
const dir = path.join(REPO, 'skills', name);
if (!fs.existsSync(path.join(dir, 'SKILL.md'))) { console.error(`no such skill: ${name}`); process.exit(1); }

const v = spawnSync('node', [path.join(REPO, 'scripts/validate-skills.mjs')], { stdio: 'inherit' });
if (v.status !== 0) { console.error('validation failed; not packaging'); process.exit(1); }

const version = (fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').match(/^\s+version:\s*"?([^"\n]+)"?/m) || [])[1] || '0.0.0';
const dist = path.join(REPO, 'dist');
fs.mkdirSync(dist, { recursive: true });
const hasZip = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;
const out = path.join(dist, `${name}-${version}.${hasZip ? 'zip' : 'tar.gz'}`);
fs.rmSync(out, { force: true });
const r = hasZip
  ? spawnSync('zip', ['-r', '-q', out, name, '-x', '*.DS_Store'], { cwd: path.join(REPO, 'skills') })
  : spawnSync('tar', ['-czf', out, '--exclude=.DS_Store', '-C', path.join(REPO, 'skills'), name]);
if (r.status !== 0) { console.error('packaging failed'); process.exit(1); }
console.log(`created ${path.relative(REPO, out)}`);
