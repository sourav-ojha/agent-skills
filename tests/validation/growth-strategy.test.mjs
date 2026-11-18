// growth-strategy helper: evidence validation, approval gates, review binding, resume, refresh, export, handoff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const GS = path.join(REPO, 'skills/growth-strategy/core/scripts/gs.mjs');
const FIX = path.join(REPO, 'tests/fixtures/growth-strategy');
const TODAY = '2026-11-18';
const MD = ['seo-audit.md', 'competitors.md', 'distribution.md', 'content-strategy.md', 'measurement-plan.md', 'monetization.md'];
const BY = ['--by', 'Sam', '--note', 'approved in chat'];

function gs(dir, args, env = {}) {
  const r = spawnSync('node', [GS, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, GS_TODAY: TODAY, SKILL_RUNLOG: 'off', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const ok = (r, what = '') => assert.equal(r.code, 0, `${what}\n${r.all}`);
const fails = (r, re) => { assert.notEqual(r.code, 0, `expected failure:\n${r.all}`); assert.match(r.all, re); };
const fx = (name, f) => path.join(FIX, name, f);
const readG = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, '.growth', f), 'utf8'));
const writeTmp = (obj) => { const f = path.join(tmpDir('gs-in-'), 'in.json'); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const copyMd = (name, dir, files) => { for (const f of files) fs.copyFileSync(fx(name, `md/${f}`), path.join(dir, '.growth', f)); };

// Drive a fixture project through the documented flow up to a recorded review. stop = phase to stop after.
function build(name, stop = 'review') {
  const dir = tmpDir('gs-proj-');
  ok(gs(dir, ['init']), 'init');
  ok(gs(dir, ['baseline', 'set', '--file', fx(name, 'baseline.json')]), 'baseline set');
  if (stop === 'baseline') return dir;
  ok(gs(dir, ['approve-baseline', ...BY]), 'approve-baseline');
  ok(gs(dir, ['add', 'sources', '--file', fx(name, 'sources.json')]), 'add sources');
  copyMd(name, dir, ['seo-audit.md']);
  ok(gs(dir, ['phase', 'done', 'audit']), 'phase audit');
  ok(gs(dir, ['add', 'keywords', '--file', fx(name, 'keywords.json')]), 'add keywords');
  copyMd(name, dir, ['competitors.md', 'distribution.md']);
  ok(gs(dir, ['phase', 'done', 'research']), 'phase research');
  if (stop === 'research') return dir;
  ok(gs(dir, ['add', 'items', '--file', fx(name, 'items.json')]), 'add items');
  copyMd(name, dir, ['content-strategy.md', 'measurement-plan.md', 'monetization.md']);
  ok(gs(dir, ['phase', 'done', 'plan']), 'phase plan');
  if (stop === 'plan') return dir;
  ok(gs(dir, ['review', 'record', '--file', fx(name, 'review.json'), '--mode', 'independent', '--reviewer', 'gs-growth-reviewer']), 'review');
  return dir;
}

for (const name of ['image-utility', 'saas', 'content-site']) {
  test(`${name}: full flow validates clean; roadmap holds approved items only; handoff and sync close the loop`, () => {
    const dir = build(name);
    const v = gs(dir, ['validate', '--json']);
    ok(v, 'validate');
    assert.deepEqual(JSON.parse(v.out).errors, []);
    ok(gs(dir, ['decide', 'GRO-001', 'approve', ...BY]));
    ok(gs(dir, ['decide', 'GRO-002', 'defer', '--by', 'Sam', '--note', 'later']));
    ok(gs(dir, ['roadmap']));
    const rm = fs.readFileSync(path.join(dir, '.growth/roadmap.md'), 'utf8');
    assert.match(rm, /GRO-001/);
    assert.match(rm.split('## Not approved')[1], /GRO-002/, 'deferred item listed only under Not approved');
    assert.doesNotMatch(rm.split('## Not approved')[0], /GRO-002/);
    assert.match(rm, /independent/);
    ok(gs(dir, ['handoff']));
    const spec = path.join(dir, '.growth/handoff/GRO-001.md');
    const items = readG(dir, 'items.json');
    if (items.find((i) => i.id === 'GRO-001').owner === 'implementer') {
      const t = fs.readFileSync(spec, 'utf8');
      assert.match(t, /^---\nid: GRO-001\nstatus: ready\nsource: growth-strategy\n/);
      assert.match(t, /## Acceptance criteria[\s\S]*Given/);
      assert.equal(readG(dir, 'items.json').find((i) => i.id === 'GRO-001').status, 'handed-off');
      // handoff is written once: the implementer's close-out edits are never overwritten
      fs.writeFileSync(spec, t.replace('status: ready', 'status: implemented\ndelivery: complete') + '\n## Delivery log\nrow\n');
      ok(gs(dir, ['handoff']));
      assert.match(fs.readFileSync(spec, 'utf8'), /## Delivery log/);
      ok(gs(dir, ['sync']));
      assert.equal(readG(dir, 'items.json').find((i) => i.id === 'GRO-001').status, 'done');
    }
    const decisions = fs.readFileSync(path.join(dir, '.growth/decisions.md'), 'utf8');
    assert.match(decisions, /GRO-001.*approve.*Sam.*approved in chat/);
  });
}

test('no product-specific assumption: the same flow works for unrelated categories with different monetization', () => {
  const b = ['image-utility', 'saas', 'content-site'].map((n) => JSON.parse(fs.readFileSync(fx(n, 'baseline.json'), 'utf8')));
  assert.equal(new Set(b.map((x) => x.category)).size, 3);
  // a site with no ads still needs the monetization file but no ad items
  assert.ok(b.some((x) => !x.monetization.includes('display-ads')));
});

test('evidence: fabricated or unsupported numbers are rejected', () => {
  const dir = build('image-utility', 'research');
  const base = readG(dir, 'keywords.json')[0];
  const cases = [
    [{ ...base, keyword: 'k1', volume: { value: 900, kind: 'estimate', source: 'S-003' } }, /volume.*estimate.*tool-export or user/],
    [{ ...base, keyword: 'k2', volume: { value: 900, kind: 'measured', source: 'S-005' } }, /measured.*gsc or analytics/],
    [{ ...base, keyword: 'k3', volume: { value: 900, kind: 'unknown', source: null } }, /unknown.*value must be null/],
    [{ ...base, keyword: 'k4', volume: { value: 900, kind: 'estimate', source: null } }, /needs a source/],
    [{ ...base, keyword: 'k5', difficulty: { value: 40, kind: 'estimate', source: 'S-999' } }, /unknown source S-999/],
    [{ ...base, keyword: 'k6', sources: ['S-404'] }, /unknown source S-404/],
    [{ ...base, keyword: 'k7', evidence: 'fact', sources: [] }, /needs at least one source/],
    [{ ...base, keyword: 'k8', evidence: 'hypothesis', confidence: 'high' }, /hypothesis.*low/],
    [{ ...base, keyword: 'k9', evidence: 'fact', confidence: 'high', sources: ['S-007'] }, /community/],
    [{ ...base, keyword: 'k10', intent: 'buying' }, /intent/],
  ];
  for (const [kw, re] of cases) fails(gs(dir, ['add', 'keywords', '--file', writeTmp([kw])]), re);
  fails(gs(dir, ['add', 'keywords', '--file', writeTmp([{ ...base, keyword: 'resize image to 20kb ' }])]), /duplicate keyword/);
  // nothing was written by the failed adds
  assert.equal(readG(dir, 'keywords.json').length, 4);
});

test('evidence: sources need a valid date (not future), a URL or ref, and file hashes for imported data', () => {
  const dir = build('image-utility', 'baseline');
  ok(gs(dir, ['approve-baseline', ...BY]));
  const s = { type: 'serp', url: 'https://serp.example/q', title: 't', accessed: TODAY };
  fails(gs(dir, ['add', 'sources', '--file', writeTmp([{ ...s, accessed: '2026-12-01' }])]), /future/);
  fails(gs(dir, ['add', 'sources', '--file', writeTmp([{ ...s, url: undefined }])]), /url or ref/);
  fails(gs(dir, ['add', 'sources', '--file', writeTmp([{ ...s, url: 'javascript:alert(1)' }])]), /http/);
  fails(gs(dir, ['add', 'sources', '--file', writeTmp([{ type: 'gsc', ref: 'file:x.csv', title: 't', accessed: TODAY }])]), /sha256/);
  fails(gs(dir, ['add', 'sources', '--file', writeTmp([{ ...s, title: 'line\nbreak' }])]), /control/);
  const r = gs(dir, ['add', 'sources', '--file', writeTmp([s])]);
  ok(r);
  assert.match(r.out, /S-001/);
});

test('evidence: items carry no traffic numbers; implementer items need Given/When/Then; low-confidence items stay out of week 1 unless cheap foundations', () => {
  const dir = build('image-utility', 'research');
  const item = JSON.parse(fs.readFileSync(fx('image-utility', 'items.json'), 'utf8'))[0];
  const { id, ...base } = item;
  fails(gs(dir, ['add', 'items', '--file', writeTmp([{ ...base, rationale: 'Will bring 5,000 visits a month.' }])]), /traffic number/);
  fails(gs(dir, ['add', 'items', '--file', writeTmp([{ ...base, acceptance: ['the sitemap exists'] }])]), /Given\/When\/Then/);
  fails(gs(dir, ['add', 'items', '--file', writeTmp([{ ...base, type: 'landing-page', confidence: 'low', evidence: 'hypothesis', sources: [] }])]), /low-confidence/);
  fails(gs(dir, ['add', 'items', '--file', writeTmp([{ ...base, status: 'approved' }])]), /helper-owned/);
  ok(gs(dir, ['add', 'items', '--file', writeTmp([{ ...base, type: 'technical-seo', confidence: 'low', evidence: 'hypothesis', sources: [], effort: 'S' }])]));
  assert.equal(readG(dir, 'items.json')[0].id, 'GRO-001');
  assert.equal(readG(dir, 'items.json')[0].status, 'proposed');
});

test('evidence: markdown tags are checked; unsourced numbers warn; two items on one keyword warn (cannibalization)', () => {
  const dir = build('image-utility', 'plan');
  const f = path.join(dir, '.growth/content-strategy.md');
  fs.appendFileSync(f, '\nBad tag [E: fact; high; S-077; 2026-11-18].\n');
  let v = JSON.parse(gs(dir, ['validate', '--json']).out);
  assert.ok(v.errors.some((e) => /S-077/.test(e)), v.errors.join('\n'));
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/Bad tag.*\n/, 'This page gets 12,000 searches a month.\n'));
  v = JSON.parse(gs(dir, ['validate', '--json']).out);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /content-strategy\.md.*number/.test(w)), v.warnings.join('\n'));
  const items = JSON.parse(fs.readFileSync(fx('image-utility', 'items.json'), 'utf8'));
  const { id, ...dup } = items[1];
  ok(gs(dir, ['add', 'items', '--file', writeTmp([{ ...dup, title: 'Another page for 20kb' }])]));
  v = JSON.parse(gs(dir, ['validate', '--json']).out);
  assert.ok(v.warnings.some((w) => /cannibalization.*resize image to 20kb/.test(w)), v.warnings.join('\n'));
});

test('gate 1: research phases refuse an unapproved or changed baseline; approval needs the user\'s words', () => {
  const dir = build('saas', 'baseline');
  fails(gs(dir, ['phase', 'done', 'audit']), /baseline is not approved/);
  fails(gs(dir, ['approve-baseline']), /--by/);
  fails(gs(dir, ['approve-baseline', '--by', 'Sam']), /--note/);
  ok(gs(dir, ['approve-baseline', ...BY]));
  ok(gs(dir, ['add', 'sources', '--file', fx('saas', 'sources.json')]));
  // a template still holding placeholders is not a finished audit
  fails(gs(dir, ['phase', 'done', 'audit']), /placeholder/);
  copyMd('saas', dir, ['seo-audit.md']);
  // the baseline changes after approval: back to draft, phases refuse
  const b = JSON.parse(fs.readFileSync(fx('saas', 'baseline.json'), 'utf8'));
  ok(gs(dir, ['baseline', 'set', '--file', writeTmp({ ...b, geographies: ['US'] })]));
  fails(gs(dir, ['phase', 'done', 'audit']), /baseline is not approved/);
  assert.match(gs(dir, ['status']).out, /baseline: draft/);
  // hand-editing the approved baseline is detected
  ok(gs(dir, ['approve-baseline', ...BY]));
  const g = readG(dir, 'growth.json');
  g.baseline.goals.push('sneaky');
  fs.writeFileSync(path.join(dir, '.growth/growth.json'), JSON.stringify(g));
  fails(gs(dir, ['phase', 'done', 'audit']), /changed after approval/);
});

test('phase order: plan needs audit and research; review needs plan', () => {
  const dir = build('saas', 'baseline');
  ok(gs(dir, ['approve-baseline', ...BY]));
  fails(gs(dir, ['phase', 'done', 'plan']), /audit.*research/);
  fails(gs(dir, ['review', 'record', '--file', fx('saas', 'review.json'), '--mode', 'independent', '--reviewer', 'r']), /plan phase/);
});

test('gate 2: decisions need a review bound to the current plan; independent by default; critical findings block approval', () => {
  const dir = build('image-utility', 'plan');
  fails(gs(dir, ['decide', 'GRO-001', 'approve', ...BY]), /no review/);
  // self-review is recorded honestly but cannot unlock decisions by default
  ok(gs(dir, ['review', 'record', '--file', fx('image-utility', 'review.json'), '--mode', 'self', '--reason', 'no sub-agents on this host']));
  assert.match(gs(dir, ['status']).out, /review: self \(not independent\)/);
  fails(gs(dir, ['decide', 'GRO-001', 'approve', ...BY]), /independent review/);
  // a report must be well formed
  fails(gs(dir, ['review', 'record', '--file', writeTmp({ verdict: 'OK', findings: [] }), '--mode', 'independent', '--reviewer', 'r']), /verdict/);
  fails(gs(dir, ['review', 'record', '--file', fx('image-utility', 'review.json'), '--mode', 'independent']), /--reviewer/);
  // independent review with a critical finding on GRO-002
  const rep = JSON.parse(fs.readFileSync(fx('image-utility', 'review.json'), 'utf8'));
  rep.findings.push({ severity: 'Critical', item: 'GRO-002', type: 'fabricated-metric', summary: 'x', fix: 'y' });
  ok(gs(dir, ['review', 'record', '--file', writeTmp(rep), '--mode', 'independent', '--reviewer', 'gs-growth-reviewer']));
  fails(gs(dir, ['decide', 'GRO-002', 'approve', ...BY]), /Critical/);
  ok(gs(dir, ['decide', 'GRO-002', 'reject', '--by', 'Sam', '--note', 'not now']));
  ok(gs(dir, ['decide', 'GRO-001', 'approve', ...BY]));
  fails(gs(dir, ['decide', 'GRO-003', 'approve', '--by', 'Sam']), /--note/);
  fails(gs(dir, ['decide', 'GRO-404', 'approve', ...BY]), /GRO-404/);
  // any plan change after review invalidates it (markdown included)
  fs.appendFileSync(path.join(dir, '.growth/monetization.md'), '\nNew idea.\n');
  fails(gs(dir, ['decide', 'GRO-003', 'approve', ...BY]), /plan changed since the last review/);
  // the user may turn the independence requirement off in their own config
  ok(gs(dir, ['review', 'record', '--file', fx('image-utility', 'review.json'), '--mode', 'self', '--reason', 'no sub-agents']));
  fs.writeFileSync(path.join(dir, '.growth/config.json'), JSON.stringify({ gates: { require_independent_review: false } }));
  ok(gs(dir, ['decide', 'GRO-003', 'approve', ...BY]));
  ok(gs(dir, ['roadmap']));
  assert.match(fs.readFileSync(path.join(dir, '.growth/roadmap.md'), 'utf8'), /self-review \(not independent\)/);
});

test('decisions are preserved: decided items cannot be silently edited, only superseded', () => {
  const dir = build('image-utility');
  ok(gs(dir, ['decide', 'GRO-002', 'approve', ...BY]));
  const items = readG(dir, 'items.json');
  const { status, ...edited } = items.find((i) => i.id === 'GRO-002');
  fails(gs(dir, ['add', 'items', '--file', writeTmp([{ ...edited, title: 'Changed title' }])]), /decided.*supersede/);
  const { id, ...repl } = edited;
  ok(gs(dir, ['add', 'items', '--file', writeTmp([{ ...repl, title: 'One page with KB presets' }])]));
  ok(gs(dir, ['supersede', 'GRO-002', '--with', 'GRO-006', ...BY]));
  const after = readG(dir, 'items.json');
  assert.equal(after.find((i) => i.id === 'GRO-002').status, 'superseded');
  assert.equal(after.find((i) => i.id === 'GRO-002').superseded_by, 'GRO-006');
  const log = readG(dir, 'growth.json').decisions.map((d) => `${d.target}:${d.decision}`);
  assert.deepEqual(log.slice(-2), ['GRO-002:approve', 'GRO-002:supersede']);
});

test('resume: status names the next step at every stage', () => {
  const empty = tmpDir('gs-empty-');
  assert.match(gs(empty, ['status']).all, /next: .*init/);
  assert.match(gs(build('saas', 'baseline'), ['status']).out, /next: .*approve/);
  const r = tmpDir('gs-r-');
  ok(gs(r, ['init'])); ok(gs(r, ['baseline', 'set', '--file', fx('saas', 'baseline.json')])); ok(gs(r, ['approve-baseline', ...BY]));
  assert.match(gs(r, ['status']).out, /next: .*audit.*research/);
  assert.match(gs(build('saas', 'research'), ['status']).out, /next: .*plan/);
  assert.match(gs(build('saas', 'plan'), ['status']).out, /next: .*review/);
  const d = build('saas');
  assert.match(gs(d, ['status']).out, /next: .*decide/);
  for (const id of ['GRO-001', 'GRO-002', 'GRO-003']) ok(gs(d, ['decide', id, 'approve', ...BY]));
  assert.match(gs(d, ['status']).out, /next: .*handoff/);
  fails(gs(tmpDir('gs-x-'), ['validate']), /init/);
  fails(gs(d, ['init']), /already/);
});

test('refresh: stale research is listed, phases reopen, decisions and approved items survive; performance data is imported as aggregates only', () => {
  const dir = build('image-utility');
  ok(gs(dir, ['decide', 'GRO-001', 'approve', ...BY]));
  const later = { GS_TODAY: '2027-03-01' };
  const plan = gs(dir, ['refresh'], later);
  ok(plan);
  assert.match(plan.out, /stale sources: .*S-003/);
  assert.match(plan.out, /stale keywords: .*resize image to 20kb/);
  ok(gs(dir, ['refresh', 'start', '--note', 'quarterly refresh'], later));
  const st = gs(dir, ['status'], later).out;
  assert.match(st, /research: stale/);
  assert.match(st, /next: .*audit.*research/);
  assert.equal(readG(dir, 'items.json').find((i) => i.id === 'GRO-001').status, 'approved');
  assert.ok(readG(dir, 'growth.json').decisions.some((d) => d.target === 'GRO-001' && d.decision === 'approve'));
  assert.equal(readG(dir, 'growth.json').refreshes.length, 1);
  // Search Console query export
  fs.mkdirSync(path.join(dir, '.growth/performance'), { recursive: true });
  const csv = path.join(dir, '.growth/performance/queries.csv');
  fs.writeFileSync(csv, 'Top queries,Clicks,Impressions,CTR,Position\n"resize image to 20kb",120,4000,3%,8.2\njane doe passport photo,1,3,33.3%,4\n');
  const imp = gs(dir, ['import', 'gsc', '--file', csv, '--period', '2027-02'], later);
  ok(imp);
  const kw = readG(dir, 'keywords.json').find((k) => k.keyword === 'resize image to 20kb');
  assert.deepEqual(kw.performance, { period: '2027-02', clicks: 120, impressions: 4000, ctr: 0.03, position: 8.2, source: kw.performance.source });
  const g = readG(dir, 'growth.json');
  assert.deepEqual(g.performance.at(-1).totals, { rows: 2, clicks: 121, impressions: 4003, matched: 1 });
  assert.doesNotMatch(JSON.stringify(g) + JSON.stringify(readG(dir, 'keywords.json')), /jane doe/, 'untracked queries are not copied');
  const src = readG(dir, 'sources.json').find((s) => s.id === kw.performance.source);
  assert.equal(src.type, 'gsc');
  assert.match(src.sha256, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(path.join(dir, '.growth/.gitignore'), 'utf8'), /performance\//);
  fails(gs(dir, ['import', 'gsc', '--file', writeTmp({})], later), /CSV/);
});

test('CSV export escapes quotes and commas and neutralises spreadsheet formulas', () => {
  const dir = build('image-utility', 'research');
  const base = readG(dir, 'keywords.json')[0];
  ok(gs(dir, ['add', 'keywords', '--file', writeTmp([{ ...base, keyword: '=hyperlink("x")', serp_notes: 'a, "b"' }])]));
  ok(gs(dir, ['export', 'keywords']));
  const csv = fs.readFileSync(path.join(dir, '.growth/keywords.csv'), 'utf8').trim().split('\n');
  assert.match(csv[0], /^keyword,cluster,intent,geo,language,volume,volume_kind,volume_source,difficulty,difficulty_kind,/);
  assert.match(csv[1], /^resize image to 20kb,resize to size,transactional,IN,en,12000,estimate,S-005,,unknown,/);
  const evil = csv.find((l) => l.includes('hyperlink'));
  assert.match(evil, /^"'=hyperlink\(""x""\)"/);
  assert.match(evil, /"a, ""b"""/);
});

test('writes never follow symbolic links planted in .growth', () => {
  const dir = build('saas', 'baseline');
  const outside = path.join(tmpDir('gs-out-'), 'target.md');
  fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(dir, '.growth/decisions.md'));
  fails(gs(dir, ['approve-baseline', ...BY]), /symbolic link/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});
