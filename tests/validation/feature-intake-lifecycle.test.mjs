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
