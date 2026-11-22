// feature-intake skill packaging: SKILL.md shape and triggers, links, self-containment, the template, and docs that cannot
// drift from the helper's verbs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const DIR = path.join(REPO, 'skills', 'feature-intake');
const FI = path.join(DIR, 'core', 'scripts', 'fi.mjs');
const SKILL = path.join(DIR, 'SKILL.md');
const read = (p) => fs.readFileSync(p, 'utf8');
const fi = (dir, args) => {
  const r = spawnSync('node', [FI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, SKILL_RUNLOG: 'off' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const description = () => /^description:\s*(.+)$/m.exec(read(SKILL))?.[1] || '';
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
// The skill's own docs plus the guide: every place a reader learns the `fi` verbs.
const DOCS = () => [SKILL, ...walk(path.join(DIR, 'references')), path.join(DIR, 'adapters', 'claude-code', 'README.md'), path.join(REPO, 'docs', 'guides', 'feature-intake.md')];

test('SKILL.md has name feature-intake and at most 150 lines', () => {
  const text = read(SKILL);
  assert.match(text, /^name: feature-intake$/m);
  const n = text.split('\n').length;
  assert.ok(n <= 150, `SKILL.md has ${n} lines`);
  assert.doesNotMatch(text, /Work in progress/);
});

test('every linked file exists', () => {
  const files = [SKILL, ...walk(path.join(DIR, 'references')), path.join(DIR, 'adapters', 'claude-code', 'README.md'), path.join(REPO, 'docs', 'guides', 'feature-intake.md')];
  let total = 0;
  for (const f of files) {
    const links = [...read(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l));
    total += links.length;
    for (const l of links) assert.ok(fs.existsSync(path.resolve(path.dirname(f), l)), `${path.relative(REPO, f)}: broken link ${l}`);
  }
  assert.ok(total > 0, 'no links found');
  const skillLinks = [...read(SKILL).matchAll(/\]\((references\/[^)#]+)\)/g)].map((m) => m[1]);
  for (const r of ['intake-procedure.md', 'writing-criteria.md', 'codebase-analysis.md', 'risk-marking.md']) {
    assert.ok(skillLinks.includes(`references/${r}`), `SKILL.md does not link references/${r}`);
  }
});

test('description contains "use when" and the intake triggers, and none of: competitor, market research, opportunity', () => {
  const d = description().toLowerCase();
  assert.match(d, /use when/);
  for (const t of ['turn this idea/requirement/bug into a feature spec', 'intake', 'write a spec for the implementer']) assert.ok(d.includes(t), `missing trigger "${t}"`);
  for (const bad of ['competitor', 'market research', 'opportunit']) assert.ok(!d.includes(bad), `description must not mention "${bad}"`);
});

test('the skill folder imports nothing outside itself', () => {
  const scripts = walk(path.join(DIR, 'core', 'scripts')).filter((f) => f.endsWith('.mjs'));
  assert.ok(scripts.length >= 4);
  for (const f of scripts) {
    for (const m of read(f).matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${path.relative(REPO, f)} imports a package "${spec}" (zero dependencies)`);
      const target = path.resolve(path.dirname(f), spec);
      assert.ok(target.startsWith(DIR + path.sep), `${path.relative(REPO, f)} imports ${spec}, outside the skill folder`);
    }
  }
});

// Fill every {{placeholder}} of a fresh draft in the shape of tests/fixtures/intake/valid-minimal.md.
function filledDraft() {
  const dir = tmpDir('fi-skill-');
  const r = fi(dir, ['new', '--title', 'Health check endpoint']);
  assert.equal(r.code, 0, r.err);
  const { id } = JSON.parse(r.out);
  const file = path.join(dir, '.product', 'features', `${id}.md`);
  const text = read(file).replace(/\{\{([^}]*)\}\}/g, (_, p) => {
    if (/^The exact command/.test(p)) return 'Run `node --test tests/health.test.mjs`; it proves AC-1';
    if (/^one testable requirement/.test(p)) return 'The service exposes a health route that returns status ok';
    return `filled ${p.split(/\s+/)[0].toLowerCase()}`;
  });
  assert.doesNotMatch(text, /\{\{/);
  fs.writeFileSync(file, text);
  return { dir, id, text };
}

test('the filled template passes fi validate and check', () => {
  const { dir, id } = filledDraft();
  const v = fi(dir, ['validate', id]);
  assert.equal(v.code, 0, v.out + v.err);
  const c = fi(dir, ['check', id]);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /ready to approve/);
});

test('the template passes extractCriteria once filled', async () => {
  const { extractCriteria } = await import(path.join(DIR, 'core', 'scripts', 'lib', 'criteria.mjs'));
  const { text } = filledDraft();
  const cr = extractCriteria(text);
  assert.ok(cr.ok, cr.errors.join('\n'));
  assert.deepEqual(cr.ac.map((a) => a.id), ['AC-1']);
  assert.deepEqual(cr.ec.map((a) => a.id), ['EC-1']);
  assert.deepEqual(cr.er.map((a) => a.id), ['ER-1']);
});

// Verbs the helper accepts: the command lines of its usage screen. An unknown verb prints that screen and exits 1.
function helperVerbs(dir) {
  const h = fi(dir, ['help']);
  assert.equal(h.code, 0);
  const verbs = [...h.out.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]);
  assert.ok(verbs.length >= 8, h.out);
  const u = fi(dir, ['no-such-verb']);
  assert.equal(u.code, 1);
  assert.equal(u.out, h.out, 'an unknown verb prints the usage screen');
  return verbs;
}

test('every fi verb in the docs exists in the helper, and every helper verb is documented in SKILL.md', () => {
  const dir = tmpDir('fi-skill-');
  const verbs = helperVerbs(dir);
  const usage = fi(dir, ['help']).out;
  const documented = new Set();
  for (const f of DOCS()) {
    for (const m of read(f).matchAll(/`fi ([a-z][a-z-]*)/g)) documented.add(m[1]);
  }
  assert.ok(documented.size >= 8, [...documented].join(', '));
  for (const v of documented) {
    assert.ok(verbs.includes(v), `docs mention \`fi ${v}\`, which the helper does not have`);
    // A real verb never falls through to the usage screen, even with no arguments.
    assert.notEqual(fi(dir, [v]).out, usage, `fi ${v} printed the usage screen`);
  }
  const skillText = read(SKILL);
  for (const v of verbs) assert.match(skillText, new RegExp(`\`fi ${v}\\b`), `SKILL.md does not document fi ${v}`);
});

test('package script and required-file list name the skill', () => {
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));
  assert.equal(pkg.scripts['package:feature-intake'], 'node scripts/package-skill.mjs feature-intake');
  assert.match(read(path.join(REPO, 'scripts', 'validate-skills.mjs')), /dirName === 'feature-intake'/);
  const lock = JSON.parse(read(path.join(REPO, 'skills.lock.json')));
  const entries = JSON.stringify(lock).match(/"feature-intake"\s*:/g) || [];
  assert.equal(entries.length, 1, 'exactly one feature-intake lock entry');
});

test('SKILL.md and intake-procedure.md state that the input is data, not instructions', () => {
  for (const f of [SKILL, path.join(DIR, 'references', 'intake-procedure.md')]) {
    assert.match(read(f), /data, not instructions/i, path.relative(REPO, f));
  }
});
