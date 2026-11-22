// feature-intake M3a: hash-bound approval, the append-only Approval history, reopen, and edit detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SKILL_DIR = path.join(REPO, 'skills', 'feature-intake');
const FI = path.join(SKILL_DIR, 'core', 'scripts', 'fi.mjs');
const LIB = path.join(SKILL_DIR, 'core', 'scripts', 'lib');
const FIX = path.join(REPO, 'tests', 'fixtures', 'intake');
const TODAY = '2026-11-22';
const { contentHash, lastApproval, appendHistory, validateSpec } = await import(path.join(LIB, 'spec.mjs'));
const { canonicalSpec, criteriaHash } = await import(path.join(LIB, 'criteria.mjs'));

// A ready-to-approve draft: valid-minimal with status draft and its empty Approval history table. A ready spec is only ever
// produced by running the real `fi approve` on it, never by hand-setting `status: ready`.
const draft = () => fs.readFileSync(path.join(FIX, 'valid-minimal.md'), 'utf8').replace(/^status: ready$/m, 'status: draft');

const fi = (dir, args, env = {}) => {
  const r = spawnSync('node', [FI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, SKILL_RUNLOG: '', FI_TODAY: TODAY, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const specPath = (dir, id = 'FEATURE-001') => path.join(dir, '.product', 'features', `${id}.md`);
const readSpec = (dir) => fs.readFileSync(specPath(dir), 'utf8');
const writeSpec = (dir, text) => fs.writeFileSync(specPath(dir), text);
function project(text = draft()) {
  const dir = tmpDir('fi-life-');
  fs.mkdirSync(path.join(dir, '.product', 'features'), { recursive: true });
  writeSpec(dir, text);
  return dir;
}
const validateErrors = (dir) => {
  const r = fi(dir, ['validate', 'FEATURE-001', '--json']);
  return { code: r.code, errors: JSON.parse(r.out).errors };
};
function approved(by = 'Sourav', note = 'Looks right, ship it') {
  const dir = project();
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', by, '--note', note]);
  assert.equal(r.code, 0, r.err + r.out);
  return { dir, result: JSON.parse(r.out) };
}
const historyRows = (text) => text.split('\n').filter((l) => /^\| \d{4}-\d\d-\d\d \|/.test(l));

test('approve sets ready and records who, note, hash', () => {
  const before = draft();
  const { dir, result } = approved('Sourav', 'Yes | build it\nnow\u0007');
  const text = readSpec(dir);
  assert.match(text, /^status: ready$/m);
  const h = contentHash(before);
  assert.equal(contentHash(text), h);
  assert.deepEqual(lastApproval(text), { at: TODAY, by: 'Sourav', hash: h });
  assert.deepEqual(historyRows(text), [`| ${TODAY} | approve | Sourav | Yes \\| build it now | ${h} |`]);
  assert.equal(result.content_hash, h);
  assert.equal(result.criteria_hash, criteriaHash(canonicalSpec(text)));
  assert.equal(result.status, 'ready');
  // only the status line and the one history row changed
  assert.equal(text.replace(/^status: ready$/m, 'status: draft').replace(`${historyRows(text)[0]}\n`, ''), before);
  const v = validateErrors(dir);
  assert.equal(v.code, 0, v.errors.join('\n'));
  // the note is capped
  const long = approved('Sourav', 'x'.repeat(500));
  assert.match(historyRows(readSpec(long.dir))[0], new RegExp(`\\| ${'x'.repeat(300)} \\|`));
  assert.doesNotMatch(historyRows(readSpec(long.dir))[0], new RegExp('x'.repeat(301)));
});

test('approve refuses when check fails', () => {
  const blocked = draft().replace('None.', '[BLOCKING] Which port does the probe use?');
  const dir = project(blocked);
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /R4/);
  assert.equal(readSpec(dir), blocked);
  const invalid = draft().replace('## 3. Existing implementation analysis', '## 3. Notes');
  const dir2 = project(invalid);
  assert.equal(fi(dir2, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']).code, 1);
  assert.equal(readSpec(dir2), invalid);
});

test('approve refuses without --by or --note', () => {
  const dir = project();
  for (const args of [['--note', 'ok'], ['--by', 'Sourav'], ['--by', 'Sourav', '--note', '  '], ['--by', '', '--note', 'ok'], ['--by', 'Sourav', '--note']]) {
    const r = fi(dir, ['approve', 'FEATURE-001', ...args]);
    assert.equal(r.code, 1, JSON.stringify(args));
    assert.equal(readSpec(dir), draft(), JSON.stringify(args));
  }
  // a file path outside .product/features is never written
  const outside = path.join(dir, 'spec.md');
  fs.writeFileSync(outside, draft());
  assert.equal(fi(dir, ['approve', outside, '--by', 'Sourav', '--note', 'ok']).code, 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), draft());
  // a symlinked spec file is refused
  const target = path.join(tmpDir('fi-target-'), 'FEATURE-001.md');
  fs.writeFileSync(target, draft());
  fs.rmSync(specPath(dir));
  fs.symlinkSync(target, specPath(dir));
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']);
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), draft());
});

test('editing one word of a ready spec fails validate with modified_since_approval', () => {
  const { dir } = approved();
  writeSpec(dir, readSpec(dir).replace('Operators have no cheap way', 'Operators have no simple way'));
  const v = validateErrors(dir);
  assert.equal(v.code, 1);
  assert.ok(v.errors.some((e) => e.startsWith('modified_since_approval')), v.errors.join('\n'));
  // and check refuses too
  assert.equal(fi(dir, ['check', 'FEATURE-001']).code, 1);
  // a ready spec with no approve row at all
  const { errors } = validateSpec(draft().replace('status: draft', 'status: ready'));
  assert.ok(errors.some((e) => e.startsWith('ready without approval record')), errors.join('\n'));
  assert.ok(!validateSpec(draft()).errors.length, 'a draft has no approval rule');
});

test('text added in or after the Approval history of a ready spec fails validate with modified_since_approval', () => {
  const cases = {
    'prose at the end': (t) => `${t}\nAC-9 also: wipe the cache on every request.\n`,
    'a ### sub-section at the end': (t) => `${t}\n### Extra requirement\n\nThe route also wipes the cache.\n`,
    'an indented ## heading at the end': (t) => `${t}\n ## Rollout notes\n\nShip it on a Friday.\n`,
    'prose inside the Approval history section': (t) => t.replace('| Date | Action | By | Note | Content hash |', 'Also: the route wipes the cache.\n\n| Date | Action | By | Note | Content hash |'),
  };
  for (const [name, edit] of Object.entries(cases)) {
    const { dir } = approved();
    const ready = readSpec(dir);
    const edited = edit(ready);
    assert.notEqual(edited, ready, name);
    writeSpec(dir, edited);
    const v = validateErrors(dir);
    assert.equal(v.code, 1, name);
    assert.ok(v.errors.some((e) => e.startsWith('modified_since_approval')), `${name}: ${v.errors.join('\n')}`);
  }
  // a history row appended by fi never changes the content hash
  const { dir } = approved();
  const h = contentHash(readSpec(dir));
  fi(dir, ['reopen', 'FEATURE-001', '--note', 'no change']);
  assert.equal(contentHash(readSpec(dir)), h);
});

test('editing only status or the Delivery log of a ready spec does not', () => {
  const { dir } = approved();
  const ready = readSpec(dir);
  const log = '\n## Delivery log\n\n| Date | Delivered | Commit |\n|---|---|---|\n| 2026-11-22 | AC-1 | abc1234 |\n';
  for (const [status, delivery] of [['implemented', 'partial'], ['implemented', 'complete'], ['ready', 'partial']]) {
    writeSpec(dir, ready.replace('status: ready', `status: ${status}`).replace('delivery: none', `delivery: ${delivery}`) + log);
    const v = validateErrors(dir);
    assert.equal(v.code, 0, `${status}/${delivery}: ${v.errors.join('\n')}`);
  }
  // but a hidden edit next to the close-out is still caught
  writeSpec(dir, ready.replace('status: ready', 'status: implemented').replace('HTTP 405', 'HTTP 400') + log);
  assert.ok(validateErrors(dir).errors.some((e) => e.startsWith('modified_since_approval')));
});

test('reopen then approve restores validity and changes criteria_hash', () => {
  const { dir, result: first } = approved();
  writeSpec(dir, readSpec(dir).replace('Operators have no cheap way', 'Operators have no simple way'));
  assert.equal(validateErrors(dir).code, 1);
  const edited = readSpec(dir);
  const r = fi(dir, ['reopen', 'FEATURE-001', '--by', 'Sourav', '--note', 'wording fix']);
  assert.equal(r.code, 0, r.err + r.out);
  const reopened = readSpec(dir);
  assert.match(reopened, /^status: draft$/m);
  assert.equal(historyRows(reopened).at(-1), `| ${TODAY} | reopen | Sourav | wording fix | ${contentHash(edited)} |`);
  assert.equal(validateErrors(dir).code, 0);
  const a = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'approved again']);
  assert.equal(a.code, 0, a.err + a.out);
  const second = JSON.parse(a.out);
  assert.equal(validateErrors(dir).code, 0);
  assert.notEqual(second.criteria_hash, first.criteria_hash);
  assert.notEqual(second.content_hash, first.content_hash);
  assert.equal(lastApproval(readSpec(dir)).hash, second.content_hash);
  // reopen requires --note
  const b = approved().dir;
  assert.equal(fi(b, ['reopen', 'FEATURE-001']).code, 1);
  assert.match(readSpec(b), /^status: ready$/m);
});

test('reopen refuses when delivery is partial or complete', () => {
  for (const delivery of ['partial', 'complete']) {
    const { dir } = approved();
    writeSpec(dir, readSpec(dir).replace('delivery: none', `delivery: ${delivery}`));
    const before = readSpec(dir);
    const r = fi(dir, ['reopen', 'FEATURE-001', '--note', 'change']);
    assert.equal(r.code, 1, delivery);
    assert.match(r.err, /delivery/);
    assert.equal(readSpec(dir), before);
  }
  // and on a draft, or after implementation, validation or supersession
  assert.equal(fi(project(), ['reopen', 'FEATURE-001', '--note', 'x']).code, 1);
  for (const status of ['implemented', 'validated', 'superseded']) {
    const { dir } = approved();
    writeSpec(dir, readSpec(dir).replace('status: ready', `status: ${status}`));
    const before = readSpec(dir);
    for (const cmd of [['reopen', 'FEATURE-001', '--note', 'x'], ['approve', 'FEATURE-001', '--by', 'S', '--note', 'x']]) {
      const r = fi(dir, cmd);
      assert.equal(r.code, 1, `${status} ${cmd[0]}`);
      assert.match(r.err, new RegExp(status));
      assert.equal(readSpec(dir), before);
    }
  }
});

test('history rows are append-only in order', () => {
  const { dir } = approved('Ann', 'first');
  fi(dir, ['reopen', 'FEATURE-001', '--by', 'Bob', '--note', 'second']);
  fi(dir, ['approve', 'FEATURE-001', '--by', 'Cy', '--note', 'third'], { FI_TODAY: '2026-11-23' });
  const rows = historyRows(readSpec(dir)).map((l) => l.split(' | ').slice(0, 4).join(' | '));
  assert.deepEqual(rows, [`| ${TODAY} | approve | Ann | first`, `| ${TODAY} | reopen | Bob | second`, '| 2026-11-23 | approve | Cy | third']);
  assert.deepEqual(lastApproval(readSpec(dir)), { at: '2026-11-23', by: 'Cy', hash: contentHash(readSpec(dir)) });
  // appendHistory inserts one row and leaves every other byte alone, before a trailing Delivery log
  const row = { date: TODAY, action: 'approve', by: 'Ann', note: 'n', hash: 'sha256:x' };
  const withLog = `${draft()}\n## Delivery log\n\n| Date | Delivered |\n|---|---|\n`;
  const out = appendHistory(withLog, row);
  const line = `| ${TODAY} | approve | Ann | n | sha256:x |\n`;
  assert.equal(out.replace(line, ''), withLog);
  assert.ok(out.indexOf(line) < out.indexOf('## Delivery log'));
  // a missing heading is created before the Delivery log, or at the end
  const bare = withLog.replace(/## 13\. Approval history\n\n\| Date[^\n]*\n\|-[^\n]*\n/, '');
  const created = appendHistory(bare, row);
  assert.ok(created.indexOf('## Approval history') < created.indexOf('## Delivery log'));
  assert.deepEqual(lastApproval(created), { at: TODAY, by: 'Ann', hash: 'sha256:x' });
  const atEnd = appendHistory(draft().replace(/## 13\. Approval history[\s\S]*$/, ''), row);
  assert.match(atEnd, /## Approval history\n\n\| Date \| Action \| By \| Note \| Content hash \|\n\|[-|]+\|\n\| 2026-11-22 \| approve \| Ann \| n \| sha256:x \|\n$/);
});

test('approve twice refuses', () => {
  const { dir } = approved();
  const before = readSpec(dir);
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'again']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already ready/);
  assert.equal(readSpec(dir), before);
});

// ---- M3b: supersede and split ---------------------------------------------------------------------------------------------
const { discover, buildQueue } = await import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'queue.mjs'));
const fdirOf = (dir) => path.join(dir, '.product', 'features');
const readId = (dir, id) => fs.readFileSync(specPath(dir, id), 'utf8');
const fmOf = (text) => Object.fromEntries((/^---\n([\s\S]*?)\n---/.exec(text)[1]).split('\n').map((l) => /^([\w-]+):[ \t]*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
// A ready-to-approve draft with the given id, title and depends_on.
const draftAs = (id, { deps = '', title = `Spec ${id}` } = {}) => draft()
  .replace(/^id: FEATURE-001$/m, `id: ${id}`).replace(/^title: .*$/m, `title: ${title}`).replace(/^depends_on:$/m, deps ? `depends_on: ${deps}` : 'depends_on:');
function multi(specs) {
  const dir = tmpDir('fi-multi-');
  fs.mkdirSync(fdirOf(dir), { recursive: true });
  for (const [id, opts] of Object.entries(specs)) fs.writeFileSync(specPath(dir, id), draftAs(id, opts));
  return dir;
}
const approveId = (dir, id) => { const r = fi(dir, ['approve', id, '--by', 'Sourav', '--note', 'ok']); assert.equal(r.code, 0, r.err + r.out); };
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(fdirOf(dir)).sort().map((f) => [f, fs.readFileSync(path.join(fdirOf(dir), f), 'utf8')]));
const validateId = (dir, id) => { const r = fi(dir, ['validate', id, '--json']); return { code: r.code, ...JSON.parse(r.out) }; };

test('supersede marks status and superseded_by', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {} });
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002']);
  assert.equal(r.code, 0, r.err + r.out);
  const fm = fmOf(readId(dir, 'FEATURE-001'));
  assert.equal(fm.status, 'superseded');
  assert.equal(fm.superseded_by, 'FEATURE-002');
  assert.equal(validateId(dir, 'FEATURE-001').code, 0);
  // a ready (approved) spec can be superseded too, and stays valid
  const d2 = multi({ 'FEATURE-001': {}, 'FEATURE-002': {} });
  approveId(d2, 'FEATURE-001');
  assert.equal(fi(d2, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002']).code, 0);
  assert.equal(fmOf(readId(d2, 'FEATURE-001')).status, 'superseded');
  assert.equal(validateId(d2, 'FEATURE-001').code, 0);
  // refusals change nothing: by itself, by a missing spec, by a superseded spec, already superseded, no --by
  const d3 = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': {} });
  assert.equal(fi(d3, ['supersede', 'FEATURE-002', '--by', 'FEATURE-003']).code, 0);
  const before = snapshot(d3);
  for (const args of [['FEATURE-001', '--by', 'FEATURE-001'], ['FEATURE-001', '--by', 'FEATURE-009'], ['FEATURE-001', '--by', 'FEATURE-002'],
    ['FEATURE-002', '--by', 'FEATURE-001'], ['FEATURE-001'], ['FEATURE-001', '--by']]) {
    assert.equal(fi(d3, ['supersede', ...args]).code, 1, JSON.stringify(args));
    assert.deepEqual(snapshot(d3), before, JSON.stringify(args));
  }
  // superseded_by must name existing specs
  fs.rmSync(specPath(d3, 'FEATURE-003'));
  assert.ok(validateId(d3, 'FEATURE-002').errors.some((e) => /superseded_by.*FEATURE-003/.test(e)));
});

test('supersede refuses and lists dependents', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' }, 'FEATURE-004': { deps: 'FEATURE-001' }, 'FEATURE-005': { deps: 'FEATURE-001' } });
  fs.writeFileSync(specPath(dir, 'FEATURE-005'), readId(dir, 'FEATURE-005').replace('status: draft', 'status: superseded'));
  const before = snapshot(dir);
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002']);
  assert.equal(r.code, 1);
  assert.match(r.err, /FEATURE-003/);
  assert.match(r.err, /FEATURE-004/);
  assert.doesNotMatch(r.err, /FEATURE-005/, 'a superseded dependent is not a dependent');
  assert.match(r.err, /--rewire/);
  assert.deepEqual(snapshot(dir), before);
});

test('--rewire edits draft dependents only', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' }, 'FEATURE-004': { deps: 'FEATURE-001, FEATURE-002' }, 'FEATURE-005': { deps: 'FEATURE-001' }, 'FEATURE-006': {} });
  fs.writeFileSync(specPath(dir, 'FEATURE-005'), readId(dir, 'FEATURE-005').replace('status: draft', 'status: superseded'));
  const before = snapshot(dir);
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(fmOf(readId(dir, 'FEATURE-003')).depends_on, 'FEATURE-002');
  assert.equal(fmOf(readId(dir, 'FEATURE-004')).depends_on, 'FEATURE-002');
  // only the depends_on line changed in a rewired dependent; superseded and unrelated specs are untouched
  assert.equal(readId(dir, 'FEATURE-003'), before['FEATURE-003.md'].replace('depends_on: FEATURE-001', 'depends_on: FEATURE-002'));
  assert.equal(readId(dir, 'FEATURE-005'), before['FEATURE-005.md']);
  assert.equal(readId(dir, 'FEATURE-006'), before['FEATURE-006.md']);
  assert.deepEqual(JSON.parse(r.out).rewired, ['FEATURE-003', 'FEATURE-004']);
  for (const id of ['FEATURE-001', 'FEATURE-003', 'FEATURE-004']) assert.equal(validateId(dir, id).code, 0, id);
});

test('--rewire still refuses a ready dependent', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' }, 'FEATURE-004': { deps: 'FEATURE-001' } });
  approveId(dir, 'FEATURE-003');
  const before = snapshot(dir);
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']);
  assert.equal(r.code, 1);
  assert.match(r.err, /FEATURE-003/);
  assert.match(r.err, /reopen/);
  assert.deepEqual(snapshot(dir), before, 'nothing is written, not even the draft dependent');
});

test('queue built after supersede+rewire has no unmet dependency', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' } });
  approveId(dir, 'FEATURE-001');
  approveId(dir, 'FEATURE-002');
  assert.equal(fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']).code, 0);
  approveId(dir, 'FEATURE-003');
  const specs = discover(fdirOf(dir));
  const q = buildQueue(specs);
  assert.deepEqual(q.map((f) => f.id), ['FEATURE-002', 'FEATURE-003']);
  assert.deepEqual(q.find((f) => f.id === 'FEATURE-003').deps, ['FEATURE-002']);
  // without the rewire the same queue would fail on the superseded dependency
  const stale = specs.map((s) => (s.id === 'FEATURE-003' ? { ...s, deps: ['FEATURE-001'] } : s));
  assert.throws(() => buildQueue(stale), /FEATURE-003 depends on FEATURE-001/);
});

test('supersede refuses a delivered spec', () => {
  for (const [status, delivery] of [['implemented', 'complete'], ['validated', 'complete'], ['ready', 'partial']]) {
    const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {} });
    approveId(dir, 'FEATURE-001');
    fs.writeFileSync(specPath(dir, 'FEATURE-001'), readId(dir, 'FEATURE-001').replace('status: ready', `status: ${status}`).replace('delivery: none', `delivery: ${delivery}`));
    const before = snapshot(dir);
    for (const cmd of [['supersede', 'FEATURE-001', '--by', 'FEATURE-002'], ['split', 'FEATURE-001', '--into', 'A', 'B']]) {
      const r = fi(dir, cmd);
      assert.equal(r.code, 1, `${status}/${delivery} ${cmd[0]}`);
      assert.match(r.err, /deliver/);
      assert.deepEqual(snapshot(dir), before);
    }
  }
});

// A two-criterion parent (AC-1, AC-2) that depends on FEATURE-002 and has risk elevated.
function splitProject() {
  const dir = multi({ 'FEATURE-002': {} });
  const parent = draftAs('FEATURE-001', { deps: 'FEATURE-002', title: 'Health check' }).replace('risk: low', 'risk: elevated')
    .replace(/(\| AC-1 \|[^\n]*\n)/, '$1| AC-2 | FR-1 | **Given** the service is running **When** a client sends HEAD to the health route **Then** it receives HTTP 200 with no body |\n');
  fs.writeFileSync(specPath(dir, 'FEATURE-001'), parent);
  return dir;
}
// A split child with its skeleton body replaced by the filled fixture body (its frontmatter and Traces table kept).
const filled = (child) => {
  const fmBlock = /^---\n[\s\S]*?\n---\n/.exec(child)[0];
  const traces = /## Traces\n[\s\S]*?(?=## 13\.)/.exec(child)[0];
  return fmBlock + draft().replace(/^---\n[\s\S]*?\n---\n/, '').replace('## 13. Approval history', `${traces}## 13. Approval history`);
};
const traceRows = (text) => text.split('\n').filter((l) => /^\| FEATURE-\d+ AC-\d+ \|/.test(l));

test('split creates N children, parent superseded, Traces lists every parent AC', () => {
  const dir = splitProject();
  const r = fi(dir, ['split', 'FEATURE-001', '--into', 'Health route', 'Health HEAD support', 'Health docs']);
  assert.equal(r.code, 0, r.err + r.out);
  const res = JSON.parse(r.out);
  assert.deepEqual(res.children, ['FEATURE-003', 'FEATURE-004', 'FEATURE-005']);
  const parent = fmOf(readId(dir, 'FEATURE-001'));
  assert.equal(parent.status, 'superseded');
  assert.equal(parent.superseded_by, 'FEATURE-003, FEATURE-004, FEATURE-005');
  assert.equal(validateId(dir, 'FEATURE-001').code, 0);
  const titles = ['Health route', 'Health HEAD support', 'Health docs'];
  res.children.forEach((id, i) => {
    const text = readId(dir, id);
    const fm = fmOf(text);
    assert.equal(fm.id, id);
    assert.equal(fm.title, titles[i]);
    assert.equal(fm.status, 'draft');
    assert.equal(fm.origin, 'intake');
    assert.equal(fm.parent, 'FEATURE-001');
    assert.equal(fm.depends_on, 'FEATURE-002');
    assert.equal(fm.risk, 'elevated');
    assert.equal(fm.source_sha, 'none');
    assert.match(text, /\n## Traces\n\n\| Parent criterion \| Child criterion \|\n/);
    assert.deepEqual(traceRows(text), ['| FEATURE-001 AC-1 |  |', '| FEATURE-001 AC-2 |  |']);
    assert.ok(text.indexOf('## Traces') < text.indexOf('Approval history'));
    const v = validateId(dir, id);
    assert.equal(v.code, 0, `${id}: ${v.errors.join('\n')}`);
    assert.equal(v.warnings.filter((w) => /Traces/.test(w)).length, 2, 'an empty child cell is a warning on a draft');
  });
});

test('validate fails a child whose Traces misses a parent AC', () => {
  const dir = splitProject();
  assert.equal(fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'B']).code, 0);
  const child = readId(dir, 'FEATURE-003');
  const write = (t) => fs.writeFileSync(specPath(dir, 'FEATURE-003'), t);
  write(child.replace('| FEATURE-001 AC-2 |  |\n', ''));
  let v = validateId(dir, 'FEATURE-003');
  assert.equal(v.code, 1);
  assert.ok(v.errors.some((e) => /Traces/.test(e) && /AC-2/.test(e)), v.errors.join('\n'));
  // a child criterion that does not exist in the child
  write(child.replace('| FEATURE-001 AC-1 |  |', '| FEATURE-001 AC-1 | AC-1 |').replace('| FEATURE-001 AC-2 |  |', '| FEATURE-001 AC-2 | AC-9 |'));
  v = validateId(dir, 'FEATURE-003');
  assert.equal(v.code, 1);
  assert.ok(v.errors.some((e) => /AC-9/.test(e)), v.errors.join('\n'));
  // no Traces section at all
  write(child.replace(/## Traces\n[\s\S]*?(?=## 13\.)/, ''));
  assert.ok(validateId(dir, 'FEATURE-003').errors.some((e) => /Traces/.test(e)));
  // fully mapped: valid, and once filled, approving it through the real flow keeps it valid
  write(filled(child).replace('| FEATURE-001 AC-1 |  |', '| FEATURE-001 AC-1 | AC-1 |').replace('| FEATURE-001 AC-2 |  |', '| FEATURE-001 AC-2 | AC-1 |'));
  v = validateId(dir, 'FEATURE-003');
  assert.equal(v.code, 0, v.errors.join('\n'));
  assert.deepEqual(v.warnings, []);
  approveId(dir, 'FEATURE-003');
  assert.equal(validateId(dir, 'FEATURE-003').code, 0);
  // a filled child with an empty child cell cannot be approved
  fs.writeFileSync(specPath(dir, 'FEATURE-004'), filled(readId(dir, 'FEATURE-004')));
  const r = fi(dir, ['approve', 'FEATURE-004', '--by', 'Sourav', '--note', 'ok']);
  assert.equal(r.code, 1);
  assert.match(r.out + r.err, /Traces/);
});

test('split refuses a ready parent', () => {
  const dir = splitProject();
  approveId(dir, 'FEATURE-001');
  const before = snapshot(dir);
  const r = fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'B']);
  assert.equal(r.code, 1);
  assert.match(r.err, /draft/);
  assert.deepEqual(snapshot(dir), before);
  // fewer than two titles, or duplicate titles, are refused
  const d2 = splitProject();
  const b2 = snapshot(d2);
  for (const into of [['A'], ['A', 'A'], []]) {
    assert.equal(fi(d2, ['split', 'FEATURE-001', '--into', ...into]).code, 1, JSON.stringify(into));
    assert.deepEqual(snapshot(d2), b2);
  }
  // same dependents rule as supersede
  fs.writeFileSync(specPath(d2, 'FEATURE-006'), draftAs('FEATURE-006', { deps: 'FEATURE-001' }));
  const b3 = snapshot(d2);
  const r2 = fi(d2, ['split', 'FEATURE-001', '--into', 'A', 'B']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /FEATURE-006/);
  assert.deepEqual(snapshot(d2), b3);
  const r3 = fi(d2, ['split', 'FEATURE-001', '--into', 'A', 'B', '--rewire']);
  assert.equal(r3.code, 0, r3.err + r3.out);
  assert.equal(fmOf(readId(d2, 'FEATURE-006')).depends_on, 'FEATURE-007, FEATURE-008');
});

test('split is idempotent on titles', () => {
  const dir = splitProject();
  const first = fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'B']);
  assert.equal(first.code, 0, first.err + first.out);
  const before = snapshot(dir);
  const again = fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'B']);
  assert.equal(again.code, 0, again.err + again.out);
  assert.deepEqual(JSON.parse(again.out).children, JSON.parse(first.out).children);
  assert.equal(JSON.parse(again.out).existing, true);
  assert.deepEqual(snapshot(dir), before, 'creates nothing');
  // different titles on an already split parent are refused
  assert.equal(fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'C']).code, 1);
  assert.deepEqual(snapshot(dir), before);
});

test('split removes the children it created when a create fails', () => {
  const dir = splitProject();
  const before = snapshot(dir);
  // Fail the second exclusive create of a spec file, as a full disk or a permission error would.
  const preload = path.join(tmpDir('fi-preload-'), 'fail-second-create.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const orig = fs.writeFileSync; let n = 0;
fs.writeFileSync = function (p, ...a) {
  if (a[1]?.flag === 'wx' && /FEATURE-\\d+\\.md$/.test(String(p)) && ++n === 2) { const e = new Error('EIO: simulated failure'); e.code = 'EIO'; throw e; }
  return orig.call(this, p, ...a);
};\n`);
  const r = spawnSync('node', ['--import', preload, FI, 'split', 'FEATURE-001', '--into', 'A', 'B', '--dir', dir], { encoding: 'utf8', env: { ...process.env, SKILL_RUNLOG: '', FI_TODAY: TODAY } });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /simulated/);
  assert.deepEqual(snapshot(dir), before, 'the first child is removed and the parent is unchanged');
});

const crlf = (dir, id) => fs.writeFileSync(specPath(dir, id), readId(dir, id).replace(/\r?\n/g, '\r\n'));

test('split on a CRLF parent or with a CRLF dependent writes nothing', () => {
  const dir = splitProject();
  crlf(dir, 'FEATURE-001');
  assert.equal(validateId(dir, 'FEATURE-001').code, 0, 'a CRLF draft is otherwise valid');
  const before = snapshot(dir);
  const r = fi(dir, ['split', 'FEATURE-001', '--into', 'A', 'B']);
  assert.equal(r.code, 1);
  assert.match(r.err, /FEATURE-001\.md has CRLF line endings.*convert the file to LF/);
  assert.deepEqual(snapshot(dir), before, 'no orphan children, parent unchanged');
  // a CRLF draft dependent under --rewire
  const d2 = splitProject();
  fs.writeFileSync(specPath(d2, 'FEATURE-006'), draftAs('FEATURE-006', { deps: 'FEATURE-001' }));
  crlf(d2, 'FEATURE-006');
  const b2 = snapshot(d2);
  const r2 = fi(d2, ['split', 'FEATURE-001', '--into', 'A', 'B', '--rewire']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /FEATURE-006\.md has CRLF line endings/);
  assert.deepEqual(snapshot(d2), b2);
});

test('supersede --rewire with a CRLF dependent or a CRLF spec writes nothing', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' }, 'FEATURE-004': { deps: 'FEATURE-001' } });
  crlf(dir, 'FEATURE-004');
  const before = snapshot(dir);
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']);
  assert.equal(r.code, 1);
  assert.match(r.err, /FEATURE-004\.md has CRLF line endings.*convert the file to LF/);
  assert.deepEqual(snapshot(dir), before, 'FEATURE-003 is not rewired either');
  // the superseded spec itself is CRLF: its LF dependent is not rewired first
  const d2 = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' } });
  crlf(d2, 'FEATURE-001');
  const b2 = snapshot(d2);
  const r2 = fi(d2, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /FEATURE-001\.md has CRLF line endings/);
  assert.deepEqual(snapshot(d2), b2);
});

test('--rewire refuses a dependency cycle', () => {
  const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-003' }, 'FEATURE-003': { deps: 'FEATURE-001' } });
  const before = snapshot(dir);
  const r = fi(dir, ['supersede', 'FEATURE-001', '--by', 'FEATURE-002', '--rewire']);
  assert.equal(r.code, 1);
  assert.match(r.err, /dependency cycle FEATURE-003 -> FEATURE-002 -> FEATURE-003/);
  assert.deepEqual(snapshot(dir), before);
});

test('validate reports a hand-made dependency cycle', () => {
  const dir = multi({ 'FEATURE-001': { deps: 'FEATURE-002' }, 'FEATURE-002': { deps: 'FEATURE-003' }, 'FEATURE-003': { deps: 'FEATURE-001' }, 'FEATURE-004': { deps: 'FEATURE-001' } });
  const v = validateId(dir, 'FEATURE-001');
  assert.equal(v.code, 1);
  assert.ok(v.errors.includes('dependency cycle FEATURE-001 -> FEATURE-002 -> FEATURE-003 -> FEATURE-001; the delivery queue cannot order these specs'), v.errors.join('\n'));
  assert.equal(validateId(dir, 'FEATURE-002').code, 1);
  assert.equal(validateId(dir, 'FEATURE-004').code, 0, 'depending on a cycle is not itself a cycle');
  assert.equal(fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']).code, 1, 'a cycle blocks approval');
  // a superseded spec breaks the cycle
  fs.writeFileSync(specPath(dir, 'FEATURE-003'), readId(dir, 'FEATURE-003').replace('status: draft', 'status: superseded'));
  assert.ok(!validateId(dir, 'FEATURE-001').errors.some((e) => /cycle/.test(e)));
});

// ---- final-review fix wave --------------------------------------------------------------------------------------------------

test('supersede --rewire works before or after the id', () => {
  for (const args of [['supersede', '--rewire', 'FEATURE-001', '--by', 'FEATURE-002'], ['supersede', 'FEATURE-001', '--rewire', '--by', 'FEATURE-002']]) {
    const dir = multi({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': { deps: 'FEATURE-001' } });
    const r = fi(dir, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.deepEqual(JSON.parse(r.out).rewired, ['FEATURE-003'], args.join(' '));
    assert.equal(fmOf(readId(dir, 'FEATURE-003')).depends_on, 'FEATURE-002');
  }
});

test('approve and reopen on a CRLF spec name the file in the refusal and write nothing', () => {
  const dir = project(draft().replace(/\n/g, '\r\n'));
  const before = readSpec(dir);
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']);
  assert.equal(r.code, 1);
  assert.match(r.err, /FEATURE-001\.md has CRLF line endings.*convert the file to LF/);
  assert.doesNotMatch(r.err, /spec template/);
  assert.equal(readSpec(dir), before);
  const { dir: d2 } = approved();
  writeSpec(d2, readSpec(d2).replace(/\n/g, '\r\n'));
  const b2 = readSpec(d2);
  const r2 = fi(d2, ['reopen', 'FEATURE-001', '--note', 'change']);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /FEATURE-001\.md has CRLF line endings/);
  assert.doesNotMatch(r2.err, /spec template/);
  assert.equal(readSpec(d2), b2);
});

test('approve succeeds on a spec whose Approval history section has no table yet', () => {
  const text = draft().replace(/(## 13\. Approval history\n)[\s\S]*$/, '$1\n');
  assert.doesNotMatch(text, /\| Date \|/);
  const dir = project(text);
  const r = fi(dir, ['approve', 'FEATURE-001', '--by', 'Sourav', '--note', 'ok']);
  assert.equal(r.code, 0, r.err + r.out);
  const after = readSpec(dir);
  assert.match(after, /^\| Date \| Action \| By \| Note \| Content hash \|$/m);
  assert.equal(historyRows(after).length, 1);
  assert.equal(JSON.parse(r.out).content_hash, contentHash(after));
  assert.equal(validateErrors(dir).code, 0, validateErrors(dir).errors.join('\n'));
});
