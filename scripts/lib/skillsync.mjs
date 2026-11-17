// Lock-file model, tree hashing and safe copying for vendored skills. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MARKER = '.agent-skills-managed';
const SKIP = new Set(['.git', '.DS_Store', MARKER]);
export const ORIGINS = ['authored', 'imported', 'vendored', 'external'];
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const safeRel = (p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').some((s) => s === '..' || s === '');
export const checkRepoUrl = (u) => /^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/\/)/.test(String(u));

// Deterministic hash of a directory: sorted relative paths + file content. Refuses symlinks.
export function treeHash(dir) {
  const h = crypto.createHash('sha256');
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new Error(`symlink not allowed in a managed tree: ${r}`);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) h.update(`${r}\0${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}\n`);
    }
  })(dir, '');
  return `sha256-${h.digest('hex')}`;
}

// Copy a tree, refusing symlinks. transform: { stripNamespace } rewrites "<ns>:" in markdown (declared in the lock, so it is reproducible).
export function copyTree(src, dst, transform) {
  const re = transform?.stripNamespace ? new RegExp(`\\b${transform.stripNamespace.replace(/[^\w-]/g, '')}:(?=[a-z])`, 'g') : null;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) throw new Error(`symlink not allowed: ${path.relative(src, s) || e.name}`);
    if (e.isDirectory()) copyTree(s, d, transform);
    else if (e.isFile()) {
      if (re && e.name.endsWith('.md')) fs.writeFileSync(d, fs.readFileSync(s, 'utf8').replace(re, ''));
      else fs.copyFileSync(s, d);
      fs.chmodSync(d, fs.statSync(s).mode & 0o777);
    }
  }
}

export const lockPath = (root) => path.join(root, 'skills.lock.json');
export function readLock(root) {
  const p = lockPath(root);
  if (!fs.existsSync(p)) return { version: 1, skills: {} };
  const l = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!l || typeof l !== 'object' || typeof l.skills !== 'object') throw new Error('skills.lock.json: expected { version, skills }');
  return l;
}
export function writeLock(root, lock) {
  const sorted = { version: lock.version || 1, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => (a < b ? -1 : 1))) };
  const tmp = `${lockPath(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n');
  fs.renameSync(tmp, lockPath(root));
}

// Commands are keyed "cmd:<name>" so a command and a skill may share a name (pr-review).
export const bareName = (key) => key.replace(/^cmd:/, '');
export const itemPath = (key, e) => (e.kind === 'command' ? `commands/${bareName(key)}.md` : `skills/${key}`);

// Consistency of the lock with the tree. Returns a list of error strings (empty = consistent).
export function lockErrors(root) {
  const errs = [];
  let lock;
  try { lock = readLock(root); } catch (e) { return [`skills.lock.json: ${e.message}`]; }
  for (const [name, e] of Object.entries(lock.skills)) {
    const at = (m) => errs.push(`${name}: ${m}`);
    if (!NAME.test(bareName(name))) at('invalid name');
    if ((e.kind === 'command') !== name.startsWith('cmd:')) at('command entries must be keyed cmd:<name>');
    if (!['skill', 'command'].includes(e.kind)) at(`invalid kind "${e.kind}"`);
    if (!ORIGINS.includes(e.origin)) at(`invalid origin "${e.origin}"`);
    if (e.origin === 'external') { if (!e.install && !e.source) at('external items need an install hint or source'); continue; }
    if (!safeRel(e.path)) { at(`unsafe path "${e.path}"`); continue; }
    if (e.path !== itemPath(name, e)) at(`path should be ${itemPath(name, e)}`);
    const full = path.join(root, e.path);
    if (!fs.existsSync(full)) { at(`missing ${e.path}`); continue; }
    if (e.origin === 'vendored') {
      if (!e.source || !checkRepoUrl(e.source.repo) || !e.source.ref || !safeRel(e.source.path)) at('vendored items need source { repo (https/ssh/file), ref, path }');
      if (!e.license || !e.licenseFile || !safeRel(e.licenseFile) || !fs.existsSync(path.join(root, e.licenseFile))) at('vendored items need a license and an existing licenseFile');
      if (e.kind === 'skill') { try { if (treeHash(full) !== e.hash) at('local edits not recorded (run: node scripts/skills.mjs accept ' + name + ')'); } catch (x) { at(x.message); } }
    }
  }
  const sk = path.join(root, 'skills');
  if (fs.existsSync(sk)) for (const d of fs.readdirSync(sk, { withFileTypes: true })) if (d.isDirectory() && !lock.skills[d.name]) errs.push(`${d.name}: skills/${d.name} has no entry in skills.lock.json`);
  const cm = path.join(root, 'commands');
  if (fs.existsSync(cm)) for (const f of fs.readdirSync(cm)) if (f.endsWith('.md') && !lock.skills[`cmd:${f.slice(0, -3)}`]) errs.push(`cmd:${f.slice(0, -3)}: commands/${f} has no entry in skills.lock.json`);
  return errs;
}
