// Per-repo run state: <home>/runs/<repo-key>.json. Zero dependencies.
// Fail closed: a corrupt state file throws RunStateError, it is never read as empty.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './factoryhome.mjs';

export class RunStateError extends Error {
  constructor(message) { super(message); this.name = 'RunStateError'; }
}

export const RUN_STATUS = ['running', 'paused', 'stopped', 'finished'];

// Same convention as privateDir in factory.mjs: 0700, a real directory, owned by this user.
function privateDir(dir) {
  try { fs.lstatSync(dir); } catch { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new RunStateError(`run directory ${dir} is a symlink, not a directory, or owned by another user`);
  return dir;
}

function fileFor(home, repoKey) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(repoKey)) || repoKey === '.' || repoKey === '..') throw new RunStateError(`invalid repo key ${repoKey}`);
  return path.join(home, 'runs', `${repoKey}.json`);
}

export function readRun(home, repoKey) {
  const file = fileFor(home, repoKey);
  if (!fs.existsSync(path.join(home, 'runs'))) return null;
  privateDir(path.join(home, 'runs'));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new RunStateError(`run file ${file} is unreadable: ${e.message}`); }
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new RunStateError(`run file ${file} is corrupt: ${e.message}`); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new RunStateError(`run file ${file} is malformed`);
  return o;
}

export function updateRun(home, repoKey, patch) {
  const file = fileFor(home, repoKey);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RunStateError('run patch must be an object');
  if ('status' in patch && !RUN_STATUS.includes(patch.status)) throw new RunStateError(`unknown run status ${patch.status}`);
  const cur = readRun(home, repoKey) || {};
  privateDir(path.join(home, 'runs'));
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  writeJsonAtomic(file, next);
  return next;
}
