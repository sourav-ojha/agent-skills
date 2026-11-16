import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL = path.join(REPO, 'skills', 'product-intelligence');
export const PI = path.join(SKILL, 'core', 'scripts', 'pi.mjs');
export const FIXTURES = path.join(REPO, 'tests', 'fixtures');
export const TODAY = '2026-11-16';

export function tmpDir(prefix = 'pi-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Copy a project fixture (repo + expected .product) into a temp dir.
export function projectFrom(scenario) {
  const dir = tmpDir();
  const repoName = scenario === 'a' ? 'scenario-a-image-utility' : 'scenario-b-dev-platform';
  fs.cpSync(path.join(FIXTURES, 'repos', repoName), dir, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'expected', `scenario-${scenario}`, '.product'), path.join(dir, '.product'), { recursive: true });
  return dir;
}

export function pi(dir, args, { pi: piPath = PI, env = {} } = {}) {
  const r = spawnSync('node', [piPath, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, PI_TODAY: TODAY, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function validateJson(dir) {
  const r = pi(dir, ['validate', '--json']);
  return JSON.parse(r.out);
}

export function edit(dir, rel, fn) {
  const p = path.join(dir, rel);
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
}

export function hasError(res, substring) {
  return res.errors.some((e) => e.includes(substring));
}
