import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { parseSession } from '../../skills/skill-insights/core/scripts/lib/transcripts.mjs';
import { windows, inventory } from '../../skills/skill-insights/core/scripts/lib/analyze.mjs';
import crypto from 'node:crypto';
import { joinTokens, coverage, latestPerFeature } from '../../skills/skill-insights/core/scripts/lib/factory.mjs';

const SI = path.join(REPO, 'skills/skill-insights/core/scripts/si.mjs');
const T = (min) => new Date(Date.UTC(2026, 10, 17, 10, min)).toISOString();
const usage = (i, o, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
const asst = (id, min, use, content) => ({ type: 'assistant', timestamp: T(min), message: { id, usage: use, content } });
const toolUse = (name, input, id = 'tu') => ({ type: 'tool_use', id, name, input });
const result = (text, isError = false, min = 2) => ({ type: 'user', timestamp: T(min), message: { content: [{ type: 'tool_result', is_error: isError, content: text }] } });

// pre-skill chatter, skill A (with a skill-file read, an error, an idle gap), then skill B.
const lines = (secretPath = '/Users/alice/secret-proj') => [
  asst('m0', 0, usage(10, 5), [{ type: 'text', text: 'PRIVATE PROMPT TEXT' }]),
  asst('m1', 1, usage(100, 50, 1000, 20), [toolUse('Skill', { skill: 'alpha' })]),
  asst('m2', 2, usage(10, 10, 2000), [toolUse('Read', { file_path: `${secretPath}/.claude/skills/alpha/references/x.md` })]),
  asst('m2', 2, usage(10, 10, 2000), [toolUse('Read', { file_path: `${secretPath}/.claude/skills/alpha/references/x.md` })]), // streamed duplicate: counted once
  asst('m2b', 2, usage(0, 0), [toolUse('Read', { file_path: `${secretPath}/.claude/skills/alpha/references/x.md` }, 'tu2')]), // same file again: repeated read
  result('x'.repeat(500), true),
  asst('m3', 40, usage(5, 5), [toolUse('Bash', { command: 'ls' })]), // 38 min idle gap
  asst('m4', 41, usage(1, 1), [toolUse('Skill', { skill: 'beta' })]),
  asst('m5', 43, usage(2, 2), [{ type: 'text', text: 'done' }]),
].map((o) => JSON.stringify(o)).join('\n') + '\nnot json {{{\n';

test('AC1 parseSession extracts skills, usage (deduped by message id), errors, skill-file reads; skips malformed lines', () => {
  const s = parseSession(lines());
  assert.deepEqual(s.entries.filter((e) => e.skill).map((e) => e.skill), ['alpha', 'beta']);
  assert.equal(s.entries.filter((e) => e.usage).length, 7); // m0..m5 plus m2b, streamed duplicate m2 once
  assert.equal(s.entries.filter((e) => e.error).length, 1);
  assert.equal(s.entries.filter((e) => e.read && e.read.skill === 'alpha').length, 2);
  assert.equal(s.skippedLines, 1);
});

test('AC2 windows attribute tokens, errors, reads to the active skill; idle gaps excluded; pre-skill is (none)', () => {
  const w = windows(parseSession(lines()), { idleMs: 10 * 60_000 });
  assert.deepEqual(w.map((x) => x.skill), ['(none)', 'alpha', 'beta']);
  const alpha = w.find((x) => x.skill === 'alpha');
  assert.equal(alpha.tokens.in, 100 + 10 + 5);
  assert.equal(alpha.tokens.out, 50 + 10 + 5);
  assert.equal(alpha.tokens.cacheRead, 1000 + 2000);
  assert.equal(alpha.toolErrors, 1);
  assert.equal(alpha.reads.length, 2);
  assert.equal(alpha.repeatedReads, 1);
  assert.ok(alpha.wallMs <= 5 * 60_000, `idle gap leaked into wall time: ${alpha.wallMs}`);
});

test('AC3 inventory counts invocations, sessions and last use; lists installed-but-unused skills', () => {
  const a = { project: 'p1', sessionId: 's1', date: '2026-11-17', ...parseSession(lines()) };
  const b = { project: 'p2', sessionId: 's2', date: '2026-11-18', ...parseSession(lines()) };
  const inv = inventory([a, b], ['alpha', 'ghost']);
  const alpha = inv.used.find((x) => x.skill === 'alpha');
  assert.deepEqual([alpha.invocations, alpha.sessions, alpha.projects, alpha.lastUsed], [2, 2, 2, '2026-11-18']);
  assert.deepEqual(inv.unused, ['ghost']);
});

function fixtureDir() {
  const root = tmpDir('si-');
  const proj = path.join(root, 'projects', '-Users-alice-secret-proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess1.jsonl'), lines());
  fs.writeFileSync(path.join(proj, 'broken.jsonl'), 'garbage\n');
  const skills = path.join(root, 'skills');
  fs.mkdirSync(path.join(skills, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
  fs.mkdirSync(path.join(skills, 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'ghost', 'SKILL.md'), '---\nname: ghost\n---\n');
  return { root, projects: path.join(root, 'projects'), skills };
}
const si = (...a) => { const r = spawnSync('node', [SI, ...a], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };

test('AC5 CLI: inventory and runs end to end; corrupt file and missing dir survive; --since filters', () => {
  const f = fixtureDir();
  const inv = si('inventory', '--projects-dir', f.projects, '--skills-dir', f.skills);
  assert.equal(inv.code, 0);
  assert.match(inv.out, /alpha/);
  assert.match(inv.out, /ghost/);
  const runs = si('runs', '--projects-dir', f.projects, '--skill', 'alpha', '--json');
  assert.equal(JSON.parse(runs.out)[0].skill, 'alpha');
  assert.notEqual(si('inventory', '--projects-dir', path.join(f.root, 'nope')).code, 0);
  assert.match(si('inventory', '--projects-dir', f.projects, '--since', '2999-01-01').out, /no sessions|0 session/i);
});

test('AC4 report is redacted: no home path, project dir name or message text', () => {
  const f = fixtureDir();
  const r = si('report', '--projects-dir', f.projects, '--skills-dir', f.skills);
  assert.equal(r.code, 0);
  for (const bad of ['alice', 'secret-proj', 'PRIVATE PROMPT TEXT', '/Users/', '.claude/skills/alpha/references/x.md']) assert.ok(!r.out.includes(bad), `leaked ${bad}`);
  assert.match(r.out, /alpha/);
});

test('AC1 slash-command skill runs are detected (command + skill body); builtin commands are not', () => {
  const u = (text, min) => JSON.stringify({ type: 'user', timestamp: T(min), message: { content: text } });
  const s = parseSession([
    u('<command-name>/clear</command-name>\n<command-args></command-args>', 0),
    u('<command-name>/implementer</command-name>\n<command-args>spec.md</command-args>', 1),
    JSON.stringify({ type: 'user', timestamp: T(1), message: { content: [{ type: 'text', text: 'Base directory for this skill: /x/.claude/skills/implementer\n\n# Implementer' }] } }),
    JSON.stringify(asst('a1', 2, usage(7, 3), [{ type: 'text', text: 'hi' }])),
  ].join('\n'));
  assert.deepEqual(s.entries.filter((e) => e.skill).map((e) => e.skill), ['implementer']);
  assert.equal(windows(s)[0].tokens.in, 7);
});

test('AC6 SKILL.md within size cap, name matches directory, links resolve', () => {
  const dir = path.join(REPO, 'skills/skill-insights');
  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(text, /^name: skill-insights$/m);
  assert.ok(text.split('\n').length <= 150);
  for (const [, l] of text.matchAll(/\]\(([^)#]+)\)/g)) if (!/^https?:/.test(l)) assert.ok(fs.existsSync(path.join(dir, l)), `broken link ${l}`);
});

// ---- runs-factory: join factory run records to transcript tokens ----
const tk = (i, o = 0, cc = 0, cr = 0) => ({ in: i, out: o, cache_create: cc, cache_read: cr });
const rec = (feature, startMin, endMin, project = 'aaaaaa', run = 'r1') => ({ kind: 'factory-run', run, feature, project, outcome: 'merged', ts_start: T(startMin), ts_end: T(endMin) });
const turn = (min, tokens, project = 'aaaaaa') => ({ project, ts: Date.parse(T(min)), tokens });

test('F1 joinTokens sums turns in non-overlapping windows; other projects and outside turns are not counted', () => {
  const out = joinTokens([rec('f1', 0, 10), rec('f2', 20, 30)], [turn(1, tk(10, 1, 2, 3)), turn(5, tk(20, 2, 4, 6)), turn(25, tk(7, 7, 7, 7)), turn(15, tk(999)), turn(2, tk(999), 'bbbbbb')]);
  assert.deepEqual([out[0].tokens_in, out[0].tokens_out, out[0].cache_create, out[0].cache_read, out[0].turns, out[0].status], [30, 3, 6, 9, 2, 'ok']);
  assert.deepEqual([out[1].tokens_in, out[1].turns, out[1].status], [7, 1, 'ok']);
  assert.equal(out[0].feature, 'f1');
});

test('F2 a turn inside two windows of the same project marks both records ambiguous', () => {
  const out = joinTokens([rec('f1', 0, 10), rec('f2', 5, 15)], [turn(7, tk(5)), turn(1, tk(1))]);
  assert.deepEqual(out.map((r) => r.status), ['ambiguous', 'ambiguous']);
  assert.equal(out[0].tokens_in, 6);
  // same window times in different projects do not collide
  const sep = joinTokens([rec('f1', 0, 10, 'aaaaaa'), rec('f2', 0, 10, 'bbbbbb')], [turn(1, tk(1), 'aaaaaa')]);
  assert.deepEqual(sep.map((r) => r.status), ['ok', 'ok']);
});

test('F3 coverage is per run, by tokens and turns, inside the run window only', () => {
  // run window 0..10 (features 0..4 and 6..10); minute 5 is inside the run but in no feature window.
  const recs = [rec('f1', 0, 4), rec('f2', 6, 10)];
  const turns = [turn(1, tk(100)), turn(8, tk(100)), turn(5, tk(200)), turn(50, tk(9999)), turn(-30, tk(9999)), turn(2, tk(9999), 'bbbbbb')];
  const [c] = coverage(recs, turns);
  assert.deepEqual([c.run, c.turns_total, c.turns_attributed, c.tokens_total, c.tokens_attributed], ['r1', 3, 2, 400, 200]);
  assert.equal(c.ratio_tokens, 0.5);
  const full = coverage([rec('f1', 0, 10)], Array.from({ length: 20 }, (_, i) => turn(i === 19 ? 50 : 1 + (i % 5), tk(1))))[0];
  assert.equal(full.ratio_turns, 1); // the turn at minute 50 is outside the run window
  const ov = joinTokens([rec('f1', 0, 10), rec('f2', 5, 15)], [turn(7, tk(5, 1))]);
  assert.deepEqual([ov[0].ambiguous_turns, ov[0].ambiguous_tokens], [1, 6]);
});

test('F4 latestPerFeature keeps the last record per (run, feature)', () => {
  const a = { ...rec('f1', 0, 1), outcome: 'failed' }; const b = { ...rec('f1', 0, 2), outcome: 'merged' };
  const out = latestPerFeature([a, b, rec('f1', 0, 1, 'aaaaaa', 'r2'), { kind: 'other' }]);
  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.run === 'r1').outcome, 'merged');
});

function factoryFixture() {
  const root = tmpDir('si-f-');
  const real = path.join(root, 'repo'); fs.mkdirSync(path.join(real, '.skill-runs'), { recursive: true });
  const link = path.join(root, 'link'); fs.symlinkSync(real, link);
  const rp = fs.realpathSync(real);
  const folder = rp.replace(/[^A-Za-z0-9]/g, '-');
  const project = crypto.createHash('sha1').update(folder).digest('hex').slice(0, 6);
  const projects = path.join(root, 'projects');
  const pd = path.join(projects, folder); fs.mkdirSync(path.join(pd, 'sess1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(pd, 'sess1.jsonl'), [asst('a1', 1, usage(100, 10, 5, 1000), [{ type: 'text', text: 'SECRET TEXT' }]), asst('a2', 3, usage(50, 5))].map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(pd, 'sess1', 'subagents', 'agent-x.jsonl'), JSON.stringify(asst('s1', 2, usage(1000, 100))) + '\n');
  fs.writeFileSync(path.join(pd, 'sess1', 'subagents', 'agent-x.meta.json'), '{}');
  const r1 = { ...rec('f1', 0, 5, project), outcome: 'failed' };
  fs.writeFileSync(path.join(real, '.skill-runs', 'factory-runs.jsonl'), [r1, { ...r1, outcome: 'merged' }, rec('f2', 30, 40, project)].map((o) => JSON.stringify(o)).join('\n') + '\n');
  return { root, real, link, projects };
}

test('F5 CLI runs-factory: resolves symlinked --dir, counts subagent transcripts, prints a table, no text leaks, --out writes enriched copy', () => {
  const f = factoryFixture();
  const r = si('runs-factory', '--dir', f.link, '--projects-dir', f.projects);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /f1/); assert.match(r.out, /f2/);
  assert.doesNotMatch(r.out, /SECRET TEXT/); assert.ok(!r.out.includes(f.root));
  const out = path.join(f.root, 'enriched.jsonl');
  const w = si('runs-factory', '--dir', f.real, '--projects-dir', f.projects, '--out', out);
  assert.equal(w.code, 0, w.out);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  const f1 = rows.find((x) => x.feature === 'f1');
  assert.equal(f1.outcome, 'merged');
  assert.deepEqual([f1.tokens_in, f1.tokens_out, f1.cache_create, f1.cache_read, f1.turns, f1.status], [1150, 115, 1000, 5, 3, 'ok']);
  assert.equal(rows.find((x) => x.feature === 'f2').turns, 0);
  assert.ok(!fs.readFileSync(path.join(f.real, '.skill-runs', 'factory-runs.jsonl'), 'utf8').includes('tokens_in'), 'source log untouched');
});

test('F6 --out refuses to overwrite the source run log (also via a symlinked path)', () => {
  const f = factoryFixture();
  const src = path.join(f.real, '.skill-runs', 'factory-runs.jsonl');
  const before = fs.readFileSync(src, 'utf8');
  for (const out of [src, path.join(f.link, '.skill-runs', 'factory-runs.jsonl')]) {
    const r = si('runs-factory', '--dir', f.real, '--projects-dir', f.projects, '--out', out);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /source run log/);
  }
  assert.equal(fs.readFileSync(src, 'utf8'), before);
});

test('F7 coverage with zero turns in the run window is null (not 100%)', () => {
  const [c] = coverage([rec('f1', 0, 10)], []);
  assert.equal(c.turns_total, 0);
  assert.equal(c.ratio_turns, null); assert.equal(c.ratio_tokens, null);
  const [d] = coverage([rec('f1', 0, 10)], [turn(50, tk(1))]); // the only turn is outside the window
  assert.equal(d.ratio_turns, null);
});

test('F8 CLI runs-factory without a transcript folder says so and prints n/a, never 100%', () => {
  const f = factoryFixture();
  const empty = path.join(f.root, 'no-projects'); fs.mkdirSync(empty);
  const r = si('runs-factory', '--dir', f.real, '--projects-dir', empty);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no transcript folder found for this project/);
  assert.match(r.out, /n\/a of tokens, n\/a of 0 turn/);
  assert.doesNotMatch(r.out, /100%/);
});

test('F9 CLI runs-factory with a transcript folder but no turns in the window prints n/a', () => {
  const f = factoryFixture();
  const pd = path.join(f.projects, fs.readdirSync(f.projects)[0]);
  fs.rmSync(pd, { recursive: true, force: true }); fs.mkdirSync(pd); // folder exists, no transcripts
  const r = si('runs-factory', '--dir', f.real, '--projects-dir', f.projects);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no transcript folder/);
  assert.match(r.out, /n\/a of tokens/);
});
