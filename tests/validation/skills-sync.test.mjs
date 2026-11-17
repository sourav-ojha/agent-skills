import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { treeHash, lockErrors } from '../../scripts/lib/skillsync.mjs';

const CLI = path.join(REPO, 'scripts/skills.mjs');
const w = (root, rel, body) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'tag.gpgsign=false', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
const skills = (root, ...a) => { const r = spawnSync('node', [CLI, ...a, '--root', root], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

function upstream() {
  const up = tmpDir('up-');
  git(up, 'init', '-q', '-b', 'main');
  w(up, 'LICENSE', 'MIT License\n\nCopyright (c) 2025 Someone\n');
  w(up, 'skills/alpha/SKILL.md', '---\nname: alpha\ndescription: Use when testing.\n---\nSee superpowers:beta and the note.\n');
  w(up, 'skills/alpha/ref.md', 'ref one\n');
  git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'v1'); git(up, 'tag', 'v1.0.0');
  return up;
}
const emptyRoot = () => { const r = tmpDir('root-'); w(r, 'skills.lock.json', JSON.stringify({ version: 1, skills: {} }, null, 2)); fs.mkdirSync(path.join(r, 'skills')); return r; };
const lock = (root) => JSON.parse(fs.readFileSync(path.join(root, 'skills.lock.json'), 'utf8'));
const vendor = (root, up, extra = []) => skills(root, 'vendor', 'alpha', '--repo', `file://${up}`, '--ref', 'v1.0.0', '--path', 'skills/alpha', '--license', 'MIT', '--strip-namespace', 'superpowers', ...extra);

test('AC1 treeHash: deterministic, order-independent, content-sensitive, ignores marker, refuses symlinks', () => {
  const a = tmpDir('h-'); w(a, 'x.md', '1'); w(a, 'd/y.md', '2');
  const b = tmpDir('h-'); w(b, 'd/y.md', '2'); w(b, 'x.md', '1'); w(b, '.agent-skills-managed', '{}');
  assert.equal(treeHash(a), treeHash(b));
  w(b, 'x.md', '1!');
  assert.notEqual(treeHash(a), treeHash(b));
  fs.symlinkSync('/etc/hosts', path.join(a, 'link'));
  assert.throws(() => treeHash(a), /symlink/i);
});

test('AC2 vendor imports a path at a pinned ref, applies the namespace transform, records hashes, copies the license', () => {
  const up = upstream(); const root = emptyRoot();
  const r = vendor(root, up);
  assert.equal(r.code, 0, r.out);
  const md = fs.readFileSync(path.join(root, 'skills/alpha/SKILL.md'), 'utf8');
  assert.ok(md.includes('See beta') && !md.includes('superpowers:'));
  const e = lock(root).skills.alpha;
  assert.deepEqual([e.origin, e.kind, e.source.ref, e.license], ['vendored', 'skill', 'v1.0.0', 'MIT']);
  assert.match(e.hash, /^sha256-/); assert.match(e.upstreamHash, /^sha256-/);
  assert.equal(e.hash, treeHash(path.join(root, 'skills/alpha')));
  assert.ok(fs.existsSync(path.join(root, e.licenseFile)));
  assert.deepEqual(lockErrors(root), []);
});

test('AC3 status flags local edits and missing items', () => {
  const up = upstream(); const root = emptyRoot(); vendor(root, up);
  assert.match(skills(root, 'status').out, /alpha.*ok/);
  w(root, 'skills/alpha/ref.md', 'edited\n');
  assert.match(skills(root, 'status').out, /alpha.*local edits/);
  fs.rmSync(path.join(root, 'skills/alpha'), { recursive: true });
  assert.match(skills(root, 'status').out, /alpha.*missing/);
});

test('AC4 update: dry run changes nothing; --apply updates files and lock; local edits block it without --force', () => {
  const up = upstream(); const root = emptyRoot(); vendor(root, up);
  w(up, 'skills/alpha/ref.md', 'ref two\n'); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'v2'); git(up, 'tag', 'v1.1.0');
  const dry = skills(root, 'update', 'alpha', '--ref', 'v1.1.0');
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /ref\.md/);
  assert.equal(lock(root).skills.alpha.source.ref, 'v1.0.0');
  assert.equal(fs.readFileSync(path.join(root, 'skills/alpha/ref.md'), 'utf8'), 'ref one\n');
  w(root, 'skills/alpha/ref.md', 'my edit\n');
  assert.notEqual(skills(root, 'update', 'alpha', '--ref', 'v1.1.0', '--apply').code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'skills/alpha/ref.md'), 'utf8'), 'my edit\n');
  assert.equal(skills(root, 'update', 'alpha', '--ref', 'v1.1.0', '--apply', '--force').code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'skills/alpha/ref.md'), 'utf8'), 'ref two\n');
  assert.equal(lock(root).skills.alpha.source.ref, 'v1.1.0');
  assert.deepEqual(lockErrors(root), []);
});

function bootRoot() {
  const root = tmpDir('boot-');
  w(root, 'skills/foo/SKILL.md', '---\nname: foo\ndescription: Use when foo.\n---\nfoo\n');
  w(root, 'commands/bar.md', 'bar command\n');
  w(root, 'skills.lock.json', JSON.stringify({ version: 1, skills: {
    foo: { kind: 'skill', origin: 'authored', path: 'skills/foo' },
    'cmd:bar': { kind: 'command', origin: 'imported', path: 'commands/bar.md' },
    tool: { kind: 'skill', origin: 'external', install: 'tool install --skill' },
  } }));
  return root;
}

test('AC5 bootstrap installs skills and commands with a marker; external gets a hint; dry-run writes nothing', () => {
  const root = bootRoot(); const proj = tmpDir('proj-');
  const dry = skills(root, 'bootstrap', '--scope', 'project', '--project-dir', proj, '--dry-run');
  assert.equal(dry.code, 0, dry.out); assert.ok(!fs.existsSync(path.join(proj, '.claude')));
  const r = skills(root, 'bootstrap', '--scope', 'project', '--project-dir', proj);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(proj, '.claude/skills/foo/.agent-skills-managed')));
  assert.equal(fs.readFileSync(path.join(proj, '.claude/commands/bar.md'), 'utf8'), 'bar command\n');
  assert.match(r.out, /tool install --skill/);
  assert.equal(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', proj).code, 0); // managed copies are replaced
});

test('AC5 bootstrap never overwrites unmanaged or symlinked destinations (--force moves aside)', () => {
  const root = bootRoot();
  const p1 = tmpDir('proj-'); w(p1, '.claude/skills/foo/SKILL.md', 'mine');
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p1).code, 0);
  assert.equal(fs.readFileSync(path.join(p1, '.claude/skills/foo/SKILL.md'), 'utf8'), 'mine');
  assert.equal(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p1, '--force').code, 0);
  assert.equal(fs.readFileSync(path.join(p1, '.claude/skills/foo.pre-bootstrap/SKILL.md'), 'utf8'), 'mine');
  const p2 = tmpDir('proj-'); const victim = tmpDir('victim-');
  fs.mkdirSync(path.join(p2, '.claude/skills'), { recursive: true }); fs.symlinkSync(victim, path.join(p2, '.claude/skills/foo'));
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p2, '--force').code, 0);
  assert.deepEqual(fs.readdirSync(victim), []);
});

test('AC6 the repo lock is consistent with skills/ (entries, hashes, licenses)', () => {
  assert.deepEqual(lockErrors(REPO), []);
});

test('AC7 unsafe lock paths and unsupported repo URLs are rejected', () => {
  const root = bootRoot();
  const l = lock(root); l.skills.foo.path = '../outside'; l.skills['cmd:bar'].path = '/etc/passwd';
  fs.writeFileSync(path.join(root, 'skills.lock.json'), JSON.stringify(l));
  const errs = lockErrors(root).join('\n');
  assert.match(errs, /foo.*path/i); assert.match(errs, /cmd:bar.*path/i);
  const proj = tmpDir('proj-');
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', proj).code, 0); // an unsafe lock is never trusted
  assert.ok(!fs.existsSync(path.join(proj, '.claude')));
  const r = skills(emptyRoot(), 'vendor', 'x', '--repo', 'ftp://example.com/x.git', '--ref', 'v1', '--path', 'skills/x', '--license', 'MIT');
  assert.notEqual(r.code, 0); assert.match(r.out, /url|scheme/i);
});

test('SEC vendor refuses upstream symlinks: path component, source root and LICENSE (no local file read into the repo)', () => {
  const victim = tmpDir('victim-'); w(victim, 'secret.txt', 'TOPSECRET');
  const mk = (fn) => { const up = tmpDir('up-'); git(up, 'init', '-q', '-b', 'main'); w(up, 'LICENSE', 'MIT\n'); w(up, 'skills/ok/SKILL.md', 'x'); fn(up); git(up, 'add', '-A'); git(up, 'commit', '-q', '-m', 'c'); git(up, 'tag', 'v1'); return up; };
  const cases = {
    root: mk((up) => fs.symlinkSync(victim, path.join(up, 'skills/evil'))),
    component: mk((up) => { fs.symlinkSync(victim, path.join(up, 'linked')); }),
    license: mk((up) => { fs.rmSync(path.join(up, 'LICENSE')); fs.symlinkSync(path.join(victim, 'secret.txt'), path.join(up, 'LICENSE')); }),
  };
  const run = (up, p) => { const root = emptyRoot(); const r = skills(root, 'vendor', 'x', '--repo', `file://${up}`, '--ref', 'v1', '--path', p, '--license', 'MIT'); return { r, root }; };
  for (const [k, up, p] of [['root', cases.root, 'skills/evil'], ['component', cases.component, 'linked'], ['license', cases.license, 'skills/ok']]) {
    const { r, root } = run(up, p);
    assert.notEqual(r.code, 0, `${k}: ${r.out}`);
    const all = spawnSync('grep', ['-r', 'TOPSECRET', root], { encoding: 'utf8' }).stdout;
    assert.equal(all, '', `${k} leaked`);
    assert.deepEqual(Object.keys(lock(root).skills), [], `${k} wrote a lock entry`);
  }
});

test('SEC project bootstrap refuses a symlinked .claude, skills dir or manifest (user files untouched)', () => {
  const root = bootRoot(); const victim = tmpDir('victim-'); w(victim, 'keep.txt', 'KEEP');
  const p1 = tmpDir('proj-'); fs.symlinkSync(victim, path.join(p1, '.claude'));
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p1).code, 0);
  assert.deepEqual(fs.readdirSync(victim), ['keep.txt']);
  const p2 = tmpDir('proj-'); fs.mkdirSync(path.join(p2, '.claude'), { recursive: true }); fs.symlinkSync(victim, path.join(p2, '.claude/skills'));
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p2).code, 0);
  assert.deepEqual(fs.readdirSync(victim), ['keep.txt']);
  const p3 = tmpDir('proj-'); fs.mkdirSync(path.join(p3, '.claude'), { recursive: true }); fs.symlinkSync(path.join(victim, 'keep.txt'), path.join(p3, '.claude/.agent-skills-manifest.json'));
  assert.notEqual(skills(root, 'bootstrap', '--scope', 'project', '--project-dir', p3).code, 0);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'KEEP');
});
