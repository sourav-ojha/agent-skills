// Current attention view: <home>/attention/<repo-key>.json (state) and .md (table). Zero dependencies.
// The event log attention/<repo-key>.jsonl is owned by the driver and never touched here.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './factoryhome.mjs';

export class AttentionError extends Error {
  constructor(message) { super(message); this.name = 'AttentionError'; }
}

const SEVERITIES = ['high', 'medium'];

function privateDir(dir) {
  try { fs.lstatSync(dir); } catch { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new AttentionError(`attention directory ${dir} is a symlink, not a directory, or owned by another user`);
  return dir;
}

function paths(home, repoKey) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(repoKey)) || repoKey === '.' || repoKey === '..') throw new AttentionError(`invalid repo key ${repoKey}`);
  const dir = path.join(home, 'attention');
  return { dir, json: path.join(dir, `${repoKey}.json`), md: path.join(dir, `${repoKey}.md`) };
}

function load(p) {
  if (!fs.existsSync(p.dir)) return [];
  privateDir(p.dir);
  let text;
  try { text = fs.readFileSync(p.json, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw new AttentionError(`attention file ${p.json} is unreadable: ${e.message}`); }
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new AttentionError(`attention file ${p.json} is corrupt: ${e.message}`); }
  if (!Array.isArray(o) || o.some((i) => !i || typeof i !== 'object')) throw new AttentionError(`attention file ${p.json} is malformed`);
  return o;
}

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function render(items) {
  const rows = items.map((i) => `| ${cell(i.severity)} | ${cell(`${i.kind}:${i.id}`)} | ${cell(i.what)} | \`${cell(i.run)}\` |`);
  return `${['| Severity | Item | What | Run |', '| --- | --- | --- | --- |', ...rows].join('\n')}\n`;
}

function save(p, items) {
  privateDir(p.dir);
  writeJsonAtomic(p.json, items);
  const tmp = `${p.md}.tmp-${process.pid}`;
  try {
    if (fs.existsSync(p.md) && fs.lstatSync(p.md).isSymbolicLink()) throw new AttentionError(`refusing to write: ${p.md} is a symlink`);
    fs.writeFileSync(tmp, render(items), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, p.md);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export const listAttention = (home, repoKey) => load(paths(home, repoKey));

// `state` (optional, a feature state) marks a row that follows the feature: the driver resolves it once the feature leaves that state.
export function addAttention(home, repoKey, { id, kind, severity, what, run, state } = {}) {
  const p = paths(home, repoKey);
  if (!id || !kind) throw new AttentionError('attention item needs id and kind');
  if (!SEVERITIES.includes(severity)) throw new AttentionError(`attention severity must be one of ${SEVERITIES.join(', ')}`);
  if (typeof run !== 'string' || !run.trim()) throw new AttentionError('attention item needs the exact command to run');
  const items = load(p);
  if (items.some((i) => i.id === id && i.kind === kind)) return;
  items.push({ id, kind, severity, what: String(what ?? ''), run, ...(typeof state === 'string' && state ? { state } : {}) });
  save(p, items);
}

export function resolveAttention(home, repoKey, { id, kind } = {}) {
  const p = paths(home, repoKey);
  const items = load(p);
  const rest = items.filter((i) => !(i.id === id && i.kind === kind));
  if (rest.length === items.length) return false;
  save(p, rest);
  return true;
}
