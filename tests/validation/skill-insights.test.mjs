import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { parseSession } from '../../skills/skill-insights/core/scripts/lib/transcripts.mjs';
import { windows, inventory } from '../../skills/skill-insights/core/scripts/lib/analyze.mjs';

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
