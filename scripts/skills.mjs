#!/usr/bin/env node
// Manage this repo's skill arsenal: vendored third-party skills (pinned, syncable) and bootstrap onto a machine.
// usage: node scripts/skills.mjs <status|check|vendor|update|accept|bootstrap> ... [--root DIR]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MARKER, treeHash, copyTree, readLock, writeLock, lockErrors, safeRel, checkRepoUrl, itemPath, bareName } from './lib/skillsync.mjs';

const BOOL = new Set(['apply', 'force', 'dry-run']);
const argv = process.argv.slice(2);
const pos = []; const f = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); if (BOOL.has(k)) f[k] = true; else f[k] = argv[++i]; } else pos.push(argv[i]);
}
const [cmd, name] = pos;
const die = (m) => { console.error(`skills: ${m}`); process.exit(1); };
const root = path.resolve(f.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const REF = /^[A-Za-z0-9][\w.\/-]{0,99}$/;
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'protocol.ext.allow=never', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// Fetch exactly one ref from an upstream repo into a temp dir (no checkout hooks, nothing executed).
function fetchUpstream(repo, ref) {
  if (!checkRepoUrl(repo)) die(`unsupported repo URL scheme (use https, ssh or file): ${repo}`);
  if (!REF.test(ref)) die(`invalid ref "${ref}"`);
  const d = tmp('skills-up-');
  try {
    git(d, 'init', '-q');
    git(d, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', repo, ref);
    git(d, 'checkout', '-q', '--detach', 'FETCH_HEAD');
  } catch (e) { rm(d); die(`cannot fetch ${ref} from ${repo}: ${(e.stderr || e.message).toString().trim().split('\n')[0]}`); }
  return { dir: d, commit: git(d, 'rev-parse', 'HEAD').trim() };
}
function stage(up, srcPath, transform) {
  if (!safeRel(srcPath)) die(`unsafe source path "${srcPath}"`);
  // Upstream is untrusted: no component of the path may be a symlink (it could point at local files outside the checkout).
  let src = up.dir;
  for (const seg of srcPath.split('/')) {
    src = path.join(src, seg);
    let st; try { st = fs.lstatSync(src); } catch { die(`source path not found in upstream: ${srcPath}`); }
    if (st.isSymbolicLink()) die(`upstream path contains a symlink, refusing: ${srcPath}`);
  }
  if (!fs.lstatSync(src).isDirectory()) die(`source path is not a directory in upstream: ${srcPath}`);
  const out = tmp('skills-stage-');
  try { copyTree(src, out, transform); } catch (e) { rm(out); die(e.message); }
  return out;
}
const files = (d) => { const a = []; (function w(x, rel) { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); const r = rel ? `${rel}/${e.name}` : e.name; if (e.name === MARKER) continue; if (e.isDirectory()) w(p, r); else a.push(r); } })(d, ''); return a.sort(); };
function diffTrees(a, b) {
  const out = []; const A = new Set(files(a)); const B = new Set(files(b));
  for (const x of B) if (!A.has(x)) out.push(`+ ${x}`); else if (!fs.readFileSync(path.join(a, x)).equals(fs.readFileSync(path.join(b, x)))) out.push(`~ ${x}`);
  for (const x of A) if (!B.has(x)) out.push(`- ${x}`);
  return out;
}
const licenseSlug = (repo) => path.basename(String(repo).replace(/\.git$/, '').replace(/\/+$/, '')).replace(/[^\w-]/g, '').toLowerCase() || 'upstream';
function findLicense(up) {
  const lic = fs.readdirSync(up.dir).find((n) => /^licen[cs]e(\.(md|txt))?$/i.test(n));
  if (!lic) die('upstream has no LICENSE file; refusing to vendor without a license');
  if (!fs.lstatSync(path.join(up.dir, lic)).isFile()) die('upstream LICENSE is not a regular file (symlink?); refusing');
  return lic;
}
function copyLicense(up, repo, lic) {
  const rel = `third_party/${licenseSlug(repo)}/LICENSE`;
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.copyFileSync(path.join(up.dir, lic), path.join(root, rel));
  return rel;
}

function cmdUpdate() {
  const e = entryOf(name);
  if (e.origin !== 'vendored' || e.kind !== 'skill') die(`${name} is not a vendored skill`);
  const ref = f.ref || e.source.ref;
  const up = fetchUpstream(e.source.repo, ref);
  let st;
  try {
    st = stage(up, e.source.path, e.transform);
    const dest = path.join(root, e.path);
    const cand = treeHash(st);
    const edited = fs.existsSync(dest) && (treeHash(dest) !== e.hash || e.hash !== e.upstreamHash);
    const changes = fs.existsSync(dest) ? diffTrees(dest, st) : ['(local copy missing)'];
    if (cand === e.upstreamHash && ref === e.source.ref) { console.log(`${name} is up to date at ${ref}`); return; }
    console.log(`${name}: ${e.source.ref} -> ${ref}${edited ? '  (local edits present)' : ''}\n${changes.join('\n') || '(no file changes)'}`);
    if (!f.apply) { console.log('dry run: nothing written (use --apply)'); return; }
    if (edited && !f.force) die(`${name} has local edits; they would be overwritten. Review the diff, then re-run with --force.`);
    const old = `${dest}.old-${process.pid}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(st, dest); st = null;
    rm(old);
    lock.skills[name] = { ...e, source: { ...e.source, ref, commit: up.commit }, upstreamHash: cand, hash: cand };
    writeLock(root, lock);
    console.log(`updated ${name} to ${ref}`);
  } finally { rm(up.dir); if (st) rm(st); }
}

const lock = (() => { try { return readLock(root); } catch (e) { return die(e.message); } })();
// Everything except status trusts the lock only if it is structurally safe (unrecorded local edits are reported by status, not fatal here).
if (cmd && cmd !== 'status') {
  const fatal = lockErrors(root).filter((e) => !/local edits not recorded/.test(e));
  if (fatal.length) die(`skills.lock.json is not safe to use:\n- ${fatal.join('\n- ')}`);
}
const entryOf = (n) => { const e = lock.skills[n]; if (!e) die(`unknown item "${n}"`); return e; };

if (cmd === 'status') {
  const bad = lockErrors(root);
  for (const [n, e] of Object.entries(lock.skills)) {
    let st = 'ok';
    if (e.origin === 'external') st = `external (${e.install || e.source?.repo || 'no hint'})`;
    else if (!fs.existsSync(path.join(root, e.path))) st = 'missing';
    else if (e.origin === 'vendored' && e.kind === 'skill') { try { st = treeHash(path.join(root, e.path)) !== e.hash ? 'local edits (unrecorded)' : (e.hash !== e.upstreamHash ? 'ok (patched, recorded)' : 'ok'); } catch (x) { st = x.message; } }
    console.log(`${n} [${e.origin}] ${e.origin === 'vendored' ? `${e.source.ref} ` : ''}${st}`);
  }
  if (bad.length) { console.log(`\n${bad.length} lock problem(s):`); bad.forEach((b) => console.log(`- ${b}`)); process.exitCode = 1; }
} else if (cmd === 'check') {
  for (const [n, e] of Object.entries(lock.skills)) {
    if (e.origin !== 'vendored') continue;
    try {
      const tags = git(root, 'ls-remote', '--tags', e.source.repo).split('\n').map((l) => (l.split('\t')[1] || '').replace('refs/tags/', '')).filter((t) => /^v?\d+\.\d+\.\d+$/.test(t));
      const key = (t) => t.replace(/^v/, '').split('.').map(Number);
      tags.sort((a, b) => { const x = key(a); const y = key(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]); });
      const latest = tags[tags.length - 1];
      console.log(`${n}: pinned ${e.source.ref}, latest ${latest || 'unknown'}${latest && latest !== e.source.ref ? '  <- update available (node scripts/skills.mjs update ' + n + ' --ref ' + latest + ')' : ''}`);
    } catch (x) { console.log(`${n}: cannot reach ${e.source.repo}`); }
  }
} else if (cmd === 'vendor') {
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) die('usage: vendor <name> --repo URL --ref TAG --path P --license SPDX [--strip-namespace NS]');
  if (!f.repo || !f.ref || !f.path || !f.license) die('vendor needs --repo, --ref, --path and --license');
  if (lock.skills[name] || fs.existsSync(path.join(root, 'skills', name))) die(`${name} already exists; use update`);
  const up = fetchUpstream(f.repo, f.ref);
  try {
    const transform = f['strip-namespace'] ? { stripNamespace: f['strip-namespace'] } : undefined;
    const lic = findLicense(up); // validated before anything is written
    const st = stage(up, f.path, transform);
    const dest = path.join(root, 'skills', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(st, dest);
    const licenseFile = copyLicense(up, f.repo, lic);
    const h = treeHash(dest);
    lock.skills[name] = { kind: 'skill', origin: 'vendored', path: `skills/${name}`, source: { repo: f.repo, ref: f.ref, commit: up.commit, path: f.path }, license: f.license, licenseFile, ...(transform ? { transform } : {}), upstreamHash: h, hash: h };
    writeLock(root, lock);
    console.log(`vendored ${name} @ ${f.ref} (${up.commit.slice(0, 7)})`);
  } finally { rm(up.dir); }
} else if (cmd === 'update') {
  cmdUpdate();
} else if (cmd === 'accept') {
  const e = entryOf(name);
  if (e.origin !== 'vendored' || e.kind !== 'skill') die(`${name} is not a vendored skill`);
  lock.skills[name] = { ...e, hash: treeHash(path.join(root, e.path)), patched: true };
  writeLock(root, lock);
  console.log(`recorded local edits for ${name}; upstream updates will now require --force`);
} else if (cmd === 'bootstrap') {
  const scope = f.scope || 'user';
  if (!['user', 'project'].includes(scope)) die('--scope must be user or project');
  const base = path.join(scope === 'user' ? os.homedir() : path.resolve(f['project-dir'] || '.'), '.claude');
  const plan = []; const problems = [];
  // Project scope trusts nothing in the project: a cloned repo could ship .claude (or its subfolders) as symlinks to elsewhere.
  // User scope is the user's own home, where symlinked dotfile setups are legitimate, so only the entries we write are checked.
  const lst = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  const mf = path.join(base, '.agent-skills-manifest.json');
  for (const d of scope === 'project' ? [base, path.join(base, 'skills'), path.join(base, 'commands')] : []) {
    const st = lst(d); if (st && (st.isSymbolicLink() || !st.isDirectory())) problems.push(`${d} is a symlink or not a directory; refusing to install into a project that redirects it`);
  }
  if (lst(mf)?.isSymbolicLink()) problems.push(`${mf} is a symlink; refusing`);
  const bkRoot = path.join(base, '.agent-skills-backup');
  { const st = lst(bkRoot); if (st && (st.isSymbolicLink() || !st.isDirectory())) problems.push(`${bkRoot} is a symlink or not a directory; refusing`); }
  if (problems.length) { problems.forEach((p) => console.error(`skills: ${p}`)); process.exit(1); }
  for (const [n, e] of Object.entries(lock.skills)) {
    if (e.origin === 'external') { plan.push({ n, hint: e.install || `see ${e.source?.repo || 'upstream'}` }); continue; }
    const src = path.join(root, itemPath(n, e));
    if (!fs.existsSync(src)) { problems.push(`${n}: source missing (${e.path})`); continue; }
    const dest = e.kind === 'command' ? path.join(base, 'commands', `${bareName(n)}.md`) : path.join(base, 'skills', n);
    let st = null; try { st = fs.lstatSync(dest); } catch { /* new */ }
    if (st?.isSymbolicLink()) { problems.push(`${n}: destination is a symlink, refusing (${dest})`); continue; }
    const managed = st && (e.kind === 'command' ? fs.existsSync(path.join(base, '.agent-skills-manifest.json')) && (JSON.parse(fs.readFileSync(path.join(base, '.agent-skills-manifest.json'), 'utf8'))[n]) : fs.existsSync(path.join(dest, MARKER)));
    // An unmanaged copy that is byte-identical to the repo's is simply adopted (marked as managed); anything different needs --force.
    let same = false;
    if (st && !managed) { try { same = e.kind === 'command' ? fs.readFileSync(src).equals(fs.readFileSync(dest)) : treeHash(src) === treeHash(dest); } catch { same = false; } }
    if (same && lst(path.join(dest, MARKER))) { problems.push(`${n}: ${path.join(dest, MARKER)} exists but does not mark a managed copy (symlink?); refusing`); continue; }
    if (st && !managed && !same && !f.force) { problems.push(`${n}: ${dest} exists, differs from the repo copy and is not managed by agent-skills (use --force to move it aside)`); continue; }
    plan.push({ n, e, src, dest, adopt: same, aside: st && !managed && !same });
  }
  if (problems.length) { problems.forEach((p) => console.error(`skills: ${p}`)); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : {};
  for (const p of plan) {
    if (p.hint) { console.log(`external ${p.n}: install separately -> ${p.hint}`); continue; }
    console.log(`${f['dry-run'] ? 'would ' : ''}${p.adopt ? 'adopt (identical, now managed)' : 'install'} ${p.n} -> ${p.dest}${p.aside ? ' (existing moved to .agent-skills-backup)' : ''}`);
    if (f['dry-run']) continue;
    fs.mkdirSync(path.dirname(p.dest), { recursive: true });
    if (p.adopt) {
      if (p.e.kind === 'command') manifest[p.n] = { from: 'agent-skills' };
      else { // temp file + rename: replaces the marker entry itself, never writes through a link
        const t = path.join(p.dest, `${MARKER}.new-${process.pid}`);
        fs.writeFileSync(t, JSON.stringify({ name: p.n, from: 'agent-skills' }) + '\n', { flag: 'wx' });
        fs.renameSync(t, path.join(p.dest, MARKER));
      }
      continue;
    }
    if (p.aside) { // outside skills/ and commands/, so a backed-up skill is never loaded as a duplicate
      const a = path.join(base, '.agent-skills-backup', stamp, p.e.kind === 'command' ? 'commands' : 'skills', path.basename(p.dest));
      if (lst(a)) die(`${a} already exists; remove it first`);
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.renameSync(p.dest, a);
    }
    if (p.e.kind === 'command') { fs.copyFileSync(p.src, p.dest); manifest[p.n] = { from: 'agent-skills' }; }
    else {
      const t = `${p.dest}.new-${process.pid}`; rm(t);
      try { copyTree(p.src, t); } catch (x) { rm(t); die(x.message); }
      fs.writeFileSync(path.join(t, MARKER), JSON.stringify({ name: p.n, from: 'agent-skills' }) + '\n');
      rm(p.dest); fs.renameSync(t, p.dest);
    }
  }
  if (!f['dry-run']) { // temp file + rename: replaces the manifest entry itself, never writes through a link
    const t = `${mf}.new-${process.pid}`;
    fs.writeFileSync(t, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    fs.renameSync(t, mf);
  }
} else die('usage: skills.mjs <status|check|vendor|update|accept|bootstrap> [name] [--root DIR]');
