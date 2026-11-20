// Daily token usage store: <home>/usage/<local YYYY-MM-DD>/<repo-key>.json. Zero dependencies.
// "Tokens" = in + out + cache_create; cache reads are recorded but never counted.
// Fail closed: an unreadable or malformed usage file throws UsageError, it is never read as zero.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './factoryhome.mjs';

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

const pad = (n) => String(n).padStart(2, '0');
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
export const tokensOf = (e) => num(e?.in) + num(e?.out) + num(e?.cache_create);

export function featureUsage(f) {
  let tokens = 0; let turns = 0;
  for (const s of Array.isArray(f?.sessions) ? f.sessions : []) { tokens += tokensOf(s); turns += num(s?.turns); }
  return { tokens, turns };
}

// Same convention as privateDir in factory.mjs: 0700, a real directory, owned by this user.
function privateDir(dir) {
  try { fs.lstatSync(dir); } catch { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new UsageError(`usage directory ${dir} is a symlink, not a directory, or owned by another user`);
  return dir;
}

const COUNTERS = ['tokens', 'cache_read', 'turns'];

function readFileStrict(file) {
  let o;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`usage file ${file} is unreadable or corrupt: ${e.message}`); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || COUNTERS.some((k) => !(Number.isFinite(o[k]) && o[k] >= 0))) throw new UsageError(`usage file ${file} is malformed`);
  return o;
}

export function addUsage(home, repoKey, date, entry) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(repoKey)) || repoKey === '.' || repoKey === '..') throw new UsageError(`invalid repo key ${repoKey}`);
  const dir = privateDir(path.join(privateDir(path.join(home, 'usage')), localDay(date)));
  const file = path.join(dir, `${repoKey}.json`);
  const cur = fs.existsSync(file) ? readFileStrict(file) : { tokens: 0, cache_read: 0, turns: 0 };
  writeJsonAtomic(file, { tokens: cur.tokens + tokensOf(entry), cache_read: cur.cache_read + num(entry?.cache_read), turns: cur.turns + num(entry?.turns) });
}

export function dayUsage(home, date) {
  const root = path.join(home, 'usage');
  const dir = path.join(root, localDay(date));
  if (!fs.existsSync(root) && !fs.existsSync(dir)) return { tokens: 0, turns: 0 };
  privateDir(root);
  if (!fs.existsSync(dir)) return { tokens: 0, turns: 0 };
  privateDir(dir);
  let tokens = 0; let turns = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue; // in-flight atomic-write temp files are named <file>.json.tmp-<pid>
    const o = readFileStrict(path.join(dir, name));
    tokens += o.tokens; turns += o.turns;
  }
  return { tokens, turns };
}
