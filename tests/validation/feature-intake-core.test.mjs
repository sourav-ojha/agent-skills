// feature-intake core: the deterministic `fi` helper (ID allocation, skeleton, validation, readiness) and lib/spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SKILL_DIR = path.join(REPO, 'skills', 'feature-intake');
const FI = path.join(SKILL_DIR, 'core', 'scripts', 'fi.mjs');
const LIB = path.join(SKILL_DIR, 'core', 'scripts', 'lib');
const FIX = path.join(REPO, 'tests', 'fixtures', 'intake');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
// valid-minimal is `status: ready` without an approval record; tests use a draft copy (approval rules come later).
const draftMinimal = () => fixture('valid-minimal.md').replace(/^status: ready$/m, 'status: draft');

const fi = (dir, args, { input } = {}) => {
  const r = spawnSync('node', [FI, ...args, '--dir', dir], { encoding: 'utf8', input, env: { ...process.env, SKILL_RUNLOG: '' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const fiJson = (dir, args) => { const r = fi(dir, [...args, '--json']); return { ...r, json: JSON.parse(r.out) }; };
const features = (dir) => path.join(dir, '.product', 'features');
const listFeatures = (dir) => (fs.existsSync(features(dir)) ? fs.readdirSync(features(dir)).filter((f) => /^FEATURE-\d+\.md$/.test(f)).sort() : []);
function project() {
  const dir = tmpDir('fi-');
  fs.mkdirSync(features(dir), { recursive: true });
  return dir;
}
function withSpec(text, id = 'FEATURE-001', dir = project()) {
  fs.writeFileSync(path.join(features(dir), `${id}.md`), text.replace(/^id: FEATURE-\d+$/m, `id: ${id}`));
  return dir;
}

test('criteria.mjs is byte-identical to delivery-orchestrator\'s copy', () => {
  const a = fs.readFileSync(path.join(LIB, 'criteria.mjs'));
  const b = fs.readFileSync(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'criteria.mjs'));
  assert.ok(a.equals(b), 'skills/feature-intake/core/scripts/lib/criteria.mjs must be copied verbatim');
});

// ---- fi new --------------------------------------------------------------------------------------------------------------

test('fi new allocates FEATURE-001 then 002', () => {
  const dir = tmpDir('fi-');
  const a = fi(dir, ['new', '--title', 'First thing']);
  assert.equal(a.code, 0, a.err);
  assert.equal(JSON.parse(a.out).id, 'FEATURE-001');
  const b = fi(dir, ['new', '--title', 'Second thing']);
  assert.equal(JSON.parse(b.out).id, 'FEATURE-002');
  assert.deepEqual(listFeatures(dir), ['FEATURE-001.md', 'FEATURE-002.md']);
  const t = fs.readFileSync(path.join(features(dir), 'FEATURE-002.md'), 'utf8');
  assert.match(t, /^id: FEATURE-002$/m);
  assert.match(t, /^title: Second thing$/m);
  assert.match(t, /^status: draft$/m);
  assert.match(t, /^origin: intake$/m);
  assert.match(t, /^source_sha: none$/m);
  assert.match(t, /^# Second thing$/m);
});

test('fi new respects a pi registry feature column', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, '.product', 'opportunities.md'), [
    '---', 'type: opportunity-registry', '---', '# Opportunities', '', '## Registry', '',
    '| ID | Title | Status | Score | Confidence | Tier | Effort | Updated | Feature |',
    '|---|---|---|---|---|---|---|---|---|',
    '| OPP-001 | Batch | Ready for Implementation | 83 | Medium | Recommend | M | 2026-11-16 | FEATURE-007 |',
    '| OPP-002 | Other | Deferred | 70 | Low | Needs evidence | S | 2026-11-16 | - |', '',
  ].join('\n'));
  fs.writeFileSync(path.join(features(dir), 'FEATURE-003.md'), draftMinimal().replace('id: FEATURE-001', 'id: FEATURE-003'));
  const r = fi(dir, ['new', '--title', 'After the registry']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).id, 'FEATURE-008');
});

test('fi new with the same --source twice returns the same id and writes one file', () => {
  const dir = tmpDir('fi-');
  const src = path.join(dir, 'idea.md');
  fs.writeFileSync(src, 'Add a health check endpoint.\n');
  const a = fi(dir, ['new', '--title', 'Health check', '--source', src]);
  assert.equal(a.code, 0, a.err);
  const first = JSON.parse(a.out);
  const t = fs.readFileSync(path.join(features(dir), `${first.id}.md`), 'utf8');
  assert.match(t, /^source_sha: sha256:[0-9a-f]{64}$/m);
  assert.match(t, /^source_ref: idea\.md$/m);
  const b = fi(dir, ['new', '--title', 'Health check again', '--source', src]);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual(JSON.parse(b.out), { existing: true, id: first.id });
  assert.deepEqual(listFeatures(dir), [`${first.id}.md`]);
  // stdin source with the same bytes is the same source
  const c = fi(dir, ['new', '--title', 'From stdin', '--source', '-'], { input: 'Add a health check endpoint.\n' });
  assert.deepEqual(JSON.parse(c.out), { existing: true, id: first.id });
});

test('parallel fi new (8 spawns) yields 8 distinct files', async () => {
  const dir = tmpDir('fi-');
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve) => {
    const p = spawn('node', [FI, 'new', '--title', `Parallel ${i}`, '--dir', dir]);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  }));
  const res = await Promise.all(runs);
  assert.ok(res.every((r) => r.code === 0), JSON.stringify(res));
  const ids = res.map((r) => JSON.parse(r.out).id);
  assert.equal(new Set(ids).size, 8);
  assert.equal(listFeatures(dir).length, 8);
  const titles = listFeatures(dir).map((f) => fs.readFileSync(path.join(features(dir), f), 'utf8').match(/^title: (.*)$/m)[1]);
  assert.equal(new Set(titles).size, 8);
});

test('fi new refuses a bad risk or an unknown dependency and writes nothing', () => {
  const dir = tmpDir('fi-');
  assert.equal(fi(dir, ['new', '--title', 'X', '--risk', 'extreme']).code, 1);
  assert.equal(fi(dir, ['new', '--title', 'X', '--depends-on', 'FEATURE-009']).code, 1);
  assert.equal(fi(dir, ['new']).code, 1);
  assert.deepEqual(listFeatures(dir), []);
});

// ---- fi validate ---------------------------------------------------------------------------------------------------------

test('validate accepts valid-minimal', () => {
  const dir = withSpec(draftMinimal());
  const r = fiJson(dir, ['validate', 'FEATURE-001']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json.errors, []);
  assert.equal(fi(dir, ['validate', path.join(features(dir), 'FEATURE-001.md')]).code, 0);
});

test('validate rejects inline-comment', () => {
  const r = fiJson(withSpec(fixture('inline-comment.md')), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /inline comment/.test(e) && e.includes('status: ready   # draft | ready')), r.json.errors.join('\n'));
});

test('validate rejects numbered-paren-headings', () => {
  const r = fiJson(withSpec(fixture('numbered-paren-headings.md').replace(/^status: ready$/m, 'status: draft')), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /^criteria: /.test(e)), r.json.errors.join('\n'));
});

test('validate rejects in-progress-status', () => {
  const r = fiJson(withSpec(fixture('in-progress-status.md')), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /status/.test(e) && /in_progress/.test(e)), r.json.errors.join('\n'));
});

test('validate rejects duplicate key', () => {
  const r = fiJson(withSpec(draftMinimal().replace('risk: low\n', 'risk: low\nrisk: high\n')), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /duplicate frontmatter key "risk"/.test(e)), r.json.errors.join('\n'));
});

test('validate rejects nested frontmatter', () => {
  const r = fiJson(withSpec(draftMinimal().replace('risk: low\n', 'risk: low\nmeta:\n  owner: someone\n')), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /nested/.test(e) && e.includes('owner: someone')), r.json.errors.join('\n'));
});

test('validate rejects Delivery log not last', () => {
  const text = draftMinimal().replace('## 13. Approval history', '## Delivery log\n\n| Date | Delivered |\n|---|---|\n\n## 13. Approval history');
  const r = fiJson(withSpec(text), ['validate', 'FEATURE-001']);
  assert.equal(r.code, 1);
  assert.ok(r.json.errors.some((e) => /Delivery log is not the last block/.test(e)), r.json.errors.join('\n'));
});

test('validate rejects other origins, missing headings and placeholders in a ready spec', async () => {
  const { validateSpec } = await import(path.join(LIB, 'spec.mjs'));
  const has = (text, re) => validateSpec(text).errors.some((e) => re.test(e));
  assert.ok(has(draftMinimal().replace('origin: intake', 'origin: product-intelligence'), /origin/));
  assert.ok(has(draftMinimal().replace('## 3. Existing implementation analysis', '## 3. Notes'), /missing section "Existing implementation analysis"/));
  assert.ok(has(fixture('valid-minimal.md').replace('None.', '{{assumptions}}'), /placeholder/));
  assert.ok(!has(draftMinimal().replace('None.', '{{assumptions}}'), /placeholder/));
  assert.ok(has('# no frontmatter\n', /no frontmatter/));
  assert.ok(validateSpec(draftMinimal().replace('depends_on:', 'depends_on: FEATURE-002'), { specs: new Map() }).errors.some((e) => /FEATURE-002/.test(e)));
});

// ---- template and fi check -----------------------------------------------------------------------------------------------

test('a fresh template-derived draft validates but check reports R1', () => {
  const dir = tmpDir('fi-');
  const { id } = JSON.parse(fi(dir, ['new', '--title', 'Fresh draft']).out);
  const v = fiJson(dir, ['validate', id]);
  assert.equal(v.code, 0, v.out);
  const c = fiJson(dir, ['check', id]);
  assert.equal(c.code, 2);
  assert.equal(c.json.ready, false);
  assert.ok(c.json.failures.some((f) => f.startsWith('R1')), c.json.failures.join('\n'));
});

test('check reports each of R2 to R8', async () => {
  // R2 cannot reach `fi check` (validate already rejects a spec whose criteria do not extract), so it is checked on readiness().
  const { readiness } = await import(path.join(LIB, 'spec.mjs'));
  const noAc = draftMinimal().replace(/^\| AC-1 .*$/m, '');
  const r2 = readiness(noAc, { specs: new Map() });
  assert.equal(r2.ok, false);
  assert.ok(r2.failures.some((f) => f.startsWith('R2')), r2.failures.join(' | '));

  const base = draftMinimal();
  const cases = {
    R3: base.replace('| FR-1 | The service exposes', '| FR-2 | A second requirement no AC covers. |\n| FR-1 | The service exposes'),
    R4: base.replace('None.', '[BLOCKING] Which port does the probe use?'),
    R5: base.replace('Non-goals: readiness of downstream dependencies, authentication, metrics.', 'Non-goals:'),
    R6: base.replace('Run `node --test tests/health.test.mjs` and confirm', 'Run the tests and confirm'),
    R7: base.replace('risk: low', 'risk: high'),
    R8: base.replace('depends_on:', 'depends_on: FEATURE-002'),
  };
  for (const [rule, text] of Object.entries(cases)) {
    const dir = withSpec(text);
    if (rule === 'R8') withSpec(base.replace('status: draft', 'status: superseded'), 'FEATURE-002', dir);
    const r = fiJson(dir, ['check', 'FEATURE-001']);
    assert.equal(r.code, 2, `${rule}: ${r.out}`);
    assert.deepEqual(r.json.failures.map((f) => f.slice(0, 2)), [rule], `${rule}: ${r.json.failures.join(' | ')}`);
  }
  // R7 is satisfied by a recorded lens note
  const lens = cases.R7.replace('The route returns no internal state and does no I/O.', 'The route returns no internal state and does no I/O.\n\nLens: security reviewed, no secrets or user data exposed.');
  assert.equal(fi(withSpec(lens), ['check', 'FEATURE-001']).code, 0);
});

test('check exits 2 when not ready, 0 when ready', () => {
  const ready = withSpec(draftMinimal());
  const ok = fiJson(ready, ['check', 'FEATURE-001']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.json.ready, true);
  assert.deepEqual(ok.json.failures, []);
  assert.equal(fi(withSpec(draftMinimal().replace('None.', '[BLOCKING] open')), ['check', 'FEATURE-001']).code, 2);
  assert.equal(fi(withSpec(fixture('in-progress-status.md')), ['check', 'FEATURE-001']).code, 1);
  assert.equal(fi(project(), ['check', 'FEATURE-404']).code, 1);
});

test('contentHash ignores the Approval history and status, but not the body', async () => {
  const { contentHash } = await import(path.join(LIB, 'spec.mjs'));
  const base = draftMinimal();
  const h = contentHash(base);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(contentHash(`${base}| 2026-11-22 | approved | someone | yes | ${h} |\n`), h);
  assert.equal(contentHash(base.replace('status: draft', 'status: ready')), h);
  assert.notEqual(contentHash(base.replace('None.', 'One assumption.')), h);
});

// ---- fi status -----------------------------------------------------------------------------------------------------------

test('status lists id, title, status, delivery, risk per spec', () => {
  const dir = tmpDir('fi-');
  fi(dir, ['new', '--title', 'Alpha']);
  fi(dir, ['new', '--title', 'Beta', '--risk', 'high']);
  const r = fiJson(dir, ['status']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.map(({ id, title, status, delivery, risk }) => ({ id, title, status, delivery, risk })), [
    { id: 'FEATURE-001', title: 'Alpha', status: 'draft', delivery: 'none', risk: 'low' },
    { id: 'FEATURE-002', title: 'Beta', status: 'draft', delivery: 'none', risk: 'high' },
  ]);
  const text = fi(dir, ['status']).out;
  assert.match(text, /FEATURE-002.*draft.*none.*high.*Beta/);
});

// ---- write boundary and run log ------------------------------------------------------------------------------------------

function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel === '.product/features' || rel.startsWith('.product/features/') || rel === '.skill-runs' || rel.startsWith('.skill-runs/')) continue;
      if (e.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); } else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

test('fi never writes outside .product/features', () => {
  const dir = tmpDir('fi-');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, 'idea.md'), 'An idea.\n');
  fs.mkdirSync(path.join(dir, '.product'));
  fs.writeFileSync(path.join(dir, '.product', 'opportunities.md'), '# Opportunities\n\n## Registry\n\n| ID | Feature |\n|---|---|\n| OPP-001 | FEATURE-002 |\n');
  const before = snapshot(dir);
  const { id } = JSON.parse(fi(dir, ['new', '--title', 'Bounded', '--source', path.join(dir, 'idea.md')]).out);
  fi(dir, ['new', '--title', 'Again', '--source', path.join(dir, 'idea.md')]);
  fi(dir, ['validate', id]);
  fi(dir, ['check', id]);
  fi(dir, ['status']);
  fi(dir, ['check', 'FEATURE-999']);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(id, 'FEATURE-003');

  // A symlinked .product or .product/features is refused before anything is created at the link target.
  for (const link of ['.product', '.product/features']) {
    const proj = tmpDir('fi-');
    const target = tmpDir('fi-target-');
    if (link === '.product/features') fs.mkdirSync(path.join(proj, '.product'));
    fs.symlinkSync(target, path.join(proj, link));
    const r = fi(proj, ['new', '--title', 'Through a link']);
    assert.equal(r.code, 1, `${link}: ${r.out}`);
    assert.match(r.err, /symbolic link/, link);
    assert.deepEqual(fs.readdirSync(target), [], `${link}: something was created at the link target`);
  }
});

test('every fi command logs one run event with outcome', () => {
  const dir = tmpDir('fi-');
  const { id } = JSON.parse(fi(dir, ['new', '--title', 'Logged']).out);
  fi(dir, ['validate', id]);
  fi(dir, ['check', id]);
  fi(dir, ['status']);
  fi(dir, ['validate', 'FEATURE-404']);
  const ev = fs.readFileSync(path.join(dir, '.skill-runs', 'feature-intake.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => e.event), ['new', 'validate', 'check', 'status', 'validate']);
  assert.deepEqual(ev.map((e) => e.ok), [true, true, true, true, false]);
  assert.ok(ev.every((e) => e.skill === 'feature-intake' && typeof e.ms === 'number'));
  assert.ok(!JSON.stringify(ev).includes('Logged'));
});
