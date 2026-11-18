// Per-user factory state directory (FACTORY_HOME) and safe JSON file helpers. Zero dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const factoryHome = () => process.env.FACTORY_HOME || path.join(os.homedir(), '.factory');
export const repoKey = (nameWithOwner) => String(nameWithOwner).replace(/\//g, '__');

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Write to <file>.tmp-<pid>, then rename. Refuses when the target or its directory is a symlink.
export function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (isLink(dir)) throw new Error(`refusing to write: ${dir} is a symlink`);
  fs.mkdirSync(dir, { recursive: true });
  if (isLink(dir)) throw new Error(`refusing to write: ${dir} is a symlink`);
  if (isLink(file)) throw new Error(`refusing to write: ${file} is a symlink`);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
