import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { REPO, tmpDir } from './helpers.mjs';
import { decode } from '../../skills/skill-insights/core/scripts/lib/proto.mjs';
import { parseAgySteps } from '../../skills/skill-insights/core/scripts/lib/agy.mjs';
import { windows, inventory } from '../../skills/skill-insights/core/scripts/lib/analyze.mjs';

const SI = path.join(REPO, 'skills/skill-insights/core/scripts/si.mjs');

// Tiny protobuf encoder: [field, value] where value is number | string | Buffer | array-of-pairs (nested message).
const vi = (n) => { const o = []; let v = BigInt(n); do { let b = Number(v & 127n); v >>= 7n; if (v) b |= 128; o.push(b); } while (v); return Buffer.from(o); };
const enc = (pairs) => Buffer.concat(pairs.map(([f, v]) => {
  if (typeof v === 'number') return Buffer.concat([vi(f << 3), vi(v)]);
  const b = typeof v === 'string' ? Buffer.from(v) : Array.isArray(v) ? enc(v) : v;
  return Buffer.concat([vi((f << 3) | 2), vi(b.length), b]);
}));
const T0 = Date.UTC(2026, 10, 23, 10, 0, 0) / 1000;
const time = (min, s = 0) => [[1, T0 + min * 60 + s], [2, 500_000_000]];
const toolStep = (min, name, args, { status = 3, id = `call_${min}_${name}`, result = 'x'.repeat(100), err = false } = {}) => {
  const meta = [[1, time(min)], [4, [[1, id], [2, name], [3, JSON.stringify(args)]]], [8, time(min, 2)]];
  return { status, error_details: err ? enc([[2, 'boom']]) : null, metadata: enc(meta), step_payload: enc([[1, 132], [5, meta], [140, [[2, [[1, result]]]]]]) };
};
const modelStep = (min, u) => {
  const meta = [[1, time(min)], [8, time(min, 1)], [9, [[1, 1319], [2, u.in], [3, u.out], [5, u.cr]]]];
  return { status: 3, error_details: null, metadata: enc(meta), step_payload: enc([[1, 15], [5, meta]]) };
};
const asRows = (steps) => steps.map((s) => ({ status: s.status, error: !!s.error_details, metadata: s.metadata, payload: s.step_payload }));
const SKILL = (n, f = 'SKILL.md') => `/Users/alice/secret-proj/skills/${n}/${f}`;
const conversation = () => [
  modelStep(0, { in: 10, out: 5, cr: 100 }),
  toolStep(1, 'run_command', { CommandLine: 'ls' }),
  modelStep(2, { in: 100, out: 50, cr: 1000 }),
  toolStep(2, 'read_file', { Path: SKILL('alpha') }),
  toolStep(3, 'view_file', { AbsolutePath: SKILL('alpha', 'references/x.md') }),
  toolStep(3, 'view_file', { AbsolutePath: SKILL('alpha', 'references/x.md') }, { status: 7, err: true }),
  toolStep(4, 'read_file', { Path: SKILL('alpha') }), // same skill again: a repeated read, not a new run
  toolStep(5, 'edit_file', { Path: '/Users/alice/secret-proj/src/a.js' }),
  toolStep(6, 'read_file', { Path: SKILL('beta') }),
  modelStep(7, { in: 7, out: 3, cr: 0 }),
];

test('proto decoder reads varints and nested bytes; malformed input returns null instead of throwing', () => {
  const m = decode(enc([[1, 300], [2, 'hi'], [3, [[1, 7]]]]));
  assert.equal(m[0][2], 300n);
  assert.equal(Buffer.from(m[1][2]).toString(), 'hi');
  assert.equal(decode(Buffer.from([0x0a, 0x09, 0x01])), null); // length runs past the end
  assert.equal(decode(Buffer.from([0x80])), null); // truncated varint
  assert.equal(decode(Buffer.from([0x00])), null); // field 0
});

test('parseAgySteps: skills from SKILL.md reads, usage from model steps, errors from status 7, no paths or text kept', () => {
  const s = parseAgySteps(asRows(conversation()));
  assert.deepEqual(s.entries.filter((e) => e.skill).map((e) => e.skill), ['alpha', 'beta']);
  assert.equal(s.entries.filter((e) => e.usage).length, 3);
  assert.deepEqual(s.entries.find((e) => e.usage), { ts: (T0 + 1) * 1000 + 500, usage: { in: 10, out: 5, cacheRead: 100, cacheWrite: 0 } });
  assert.equal(s.entries.filter((e) => e.error).length, 1);
  assert.equal(s.entries.filter((e) => e.read && e.read.skill === 'alpha').length, 3); // references/x.md twice, plus SKILL.md again
  assert.ok(s.entries.some((e) => e.wrote && e.fileKey));
  assert.ok(s.entries.every((e) => !e.bytes || e.bytes < 1000));
  assert.ok(!JSON.stringify(s).includes('xxxx')); // result text is never kept (skill-file paths stay in memory, as with Claude Code, and are never printed)
  const w = windows(s);
  assert.deepEqual(w.map((x) => x.skill), ['(none)', 'alpha', 'beta']);
  const alpha = w.find((x) => x.skill === 'alpha');
  assert.equal(alpha.toolErrors, 1);
  assert.equal(alpha.repeatedReads, 1); // references/x.md read twice (the SKILL.md that opened the window is not counted)
  assert.deepEqual(inventory([{ project: 'p', sessionId: 's', date: '2026-11-23', entries: s.entries }], ['alpha', 'gamma']).unused, ['gamma']);
});

test('parseAgySteps skips steps it cannot read and counts them', () => {
  const s = parseAgySteps([{ status: 3, metadata: Buffer.from([0x80]), payload: null }, ...asRows([modelStep(0, { in: 1, out: 1, cr: 0 })])]);
  assert.equal(s.entries.length, 1);
  assert.equal(s.skippedLines, 1);
});

test('si --host antigravity reads conversation SQLite files end to end, skips sub-conversations, never prints paths', () => {
  const root = tmpDir();
  const convs = path.join(root, 'antigravity-cli', 'conversations');
  fs.mkdirSync(convs, { recursive: true });
  const write = (id, steps, parent) => {
    const db = new DatabaseSync(path.join(convs, `${id}.db`));
    db.exec('create table steps (idx integer primary key, step_type integer, status integer, error_details blob, metadata blob, step_payload blob); create table gen_metadata (idx integer primary key, data blob)');
    steps.forEach((s, i) => db.prepare('insert into steps values (?,?,?,?,?,?)').run(i, 0, s.status, s.error_details, s.metadata, s.step_payload));
    if (parent) db.prepare('insert into gen_metadata values (0, ?)').run(enc([[1, [[20, [[1, 'parent_cascade_id'], [2, parent]]]]]]));
    db.close();
  };
  write('aaaa', conversation());
  write('bbbb', conversation(), 'aaaa');
  const sk = path.join(root, 'skills'); fs.mkdirSync(path.join(sk, 'gamma'), { recursive: true }); fs.writeFileSync(path.join(sk, 'gamma', 'SKILL.md'), '---\nname: gamma\n---\n');
  const r = spawnSync(process.execPath, ['--no-warnings', SI, 'inventory', '--host', 'antigravity', '--projects-dir', convs, '--skills-dir', sk, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const inv = JSON.parse(r.stdout);
  assert.deepEqual(inv.used.map((u) => [u.skill, u.invocations]).sort(), [['alpha', 1], ['beta', 1]]); // the sub-conversation is not double counted
  assert.deepEqual(inv.unused, ['gamma']);
  assert.ok(!r.stdout.includes('secret-proj'));
  const bad = spawnSync(process.execPath, [SI, 'report', '--host', 'nope'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});
