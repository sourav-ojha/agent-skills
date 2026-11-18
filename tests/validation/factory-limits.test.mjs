// P0.3: usage-limit classifier (pure) and capture tooling (hook + wrapper). Fixtures only: no real `claude` is ever called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

process.env.TZ = 'UTC';
const SC = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const CAPTURE = path.join(SC, 'capture.mjs');
const { classifyFailure } = await import(path.join(SC, 'lib', 'limits.mjs'));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'limits', n), 'utf8'));
// 2026-11-18 is a Wednesday; 10:00 UTC
const NOW = new Date('2026-11-18T10:00:00Z');
const c = (n) => classifyFailure(fx(n), { now: NOW });

test('session limit from text, reset today (local time)', () => {
  assert.deepEqual(c('session-text.json'), { kind: 'session', resetAt: '2026-11-18T15:45:00.000Z', source: 'text' });
});
test('weekly limit from text, reset on a named weekday', () => {
  assert.deepEqual(c('weekly-text.json'), { kind: 'weekly', resetAt: '2026-11-23T00:00:00.000Z', source: 'text' });
});
test('model limit from text, hour-only reset', () => {
  assert.deepEqual(c('model-text.json'), { kind: 'model', resetAt: '2026-11-18T18:00:00.000Z', source: 'text' });
});
test('a time already passed today rolls to tomorrow', () => {
  const r = classifyFailure({ is_error: true, result: 'You\'ve hit your session limit · resets 9:00am' }, { now: NOW });
  assert.equal(r.resetAt, '2026-11-19T09:00:00.000Z');
});
test('reset text honours the local timezone', () => {
  const env = { ...process.env, TZ: 'America/New_York' };
  const code = `const {classifyFailure}=await import(${JSON.stringify(path.join(SC, 'lib', 'limits.mjs'))});console.log(classifyFailure({is_error:true,result:"session limit · resets 3:45pm"},{now:new Date("2026-11-18T10:00:00Z")}).resetAt)`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '2026-11-18T20:45:00.000Z');
});
test('rate limit from text and from status 429 alone', () => {
  assert.deepEqual(c('rate-text.json'), { kind: 'rate', resetAt: null, source: 'text' });
  assert.deepEqual(c('rate-status-only.json'), { kind: 'rate', resetAt: null, source: 'status' });
});
test('rate_limit_event wins over text; epoch reset', () => {
  assert.deepEqual(c('session-event.json'), { kind: 'session', resetAt: new Date(1795000000 * 1000).toISOString(), source: 'event' });
});
test('seven_day* is weekly, model names are model', () => {
  assert.equal(c('weekly-event.json').kind, 'weekly');
  assert.equal(c('weekly-event.json').source, 'event');
  assert.equal(c('model-event.json').kind, 'model');
  // a weekly cap scoped to one model is a model limit (the model-specific wait is what matters)
  assert.equal(classifyFailure({ is_error: true, rate_limit_event: { status: 'rejected', rateLimitType: 'seven_day_opus' } }).kind, 'model');
});
test('epoch in milliseconds is accepted', () => {
  const r = classifyFailure({ is_error: true, rate_limit_event: { status: 'rejected', resetsAt: 1795000000000, rateLimitType: 'five_hour' } });
  assert.equal(r.resetAt, new Date(1795000000000).toISOString());
});
test('success payloads are other, no reset', () => {
  for (const n of ['success.json', 'success-allowed-event.json', 'real-allowed-stream.json', 'not-error-with-limit-text.json']) {
    assert.deepEqual(c(n), { kind: 'other', resetAt: null, source: 'none' }, n);
  }
});
test('allowed_warning event plus an unrelated error is other', () => {
  assert.deepEqual(c('allowed-warning-unrelated-error.json'), { kind: 'other', resetAt: null, source: 'none' });
});
test('is_error with unrelated text is other', () => {
  assert.deepEqual(c('error-unrelated.json'), { kind: 'other', resetAt: null, source: 'none' });
});
test('StopFailure hook payload: rate_limit error with text', () => {
  assert.deepEqual(c('stopfailure-hook.json'), { kind: 'session', resetAt: '2026-11-18T15:45:00.000Z', source: 'text' });
  assert.deepEqual(classifyFailure({ hook_event_name: 'StopFailure', error: 'rate_limit' }, { now: NOW }), { kind: 'rate', resetAt: null, source: 'status' });
});
test('string and junk inputs never throw', () => {
  assert.equal(classifyFailure('', {}).kind, 'other');
  assert.equal(classifyFailure(null).kind, 'other');
  assert.equal(classifyFailure(42).kind, 'other');
  assert.equal(classifyFailure('not json at all').kind, 'other');
  assert.equal(classifyFailure(JSON.stringify(fx('session-text.json')), { now: NOW }).kind, 'session');
  assert.equal(classifyFailure(fx('session-event.json').map((e) => JSON.stringify(e)).join('\n'), { now: NOW }).kind, 'session');
});

function run(args, { input, home, bin } = {}) {
  const env = { ...process.env, FACTORY_HOME: home, PATH: `${bin ? `${bin}:` : ''}${process.env.PATH}` };
  return spawnSync(process.execPath, [CAPTURE, ...args], { input, env, encoding: 'utf8' });
}
const caps = (home) => { const d = path.join(home, 'captures'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')) : []; };

test('capture hook writes a redacted payload under FACTORY_HOME/captures', () => {
  const home = tmpDir('limits-home-');
  const payload = { ...fx('stopfailure-hook.json'), session_id: '123e4567-e89b-12d3-a456-426614174000', cwd: '/Users/someone/proj', email: 'a@b.com' };
  const r = run(['hook'], { input: JSON.stringify(payload), home });
  assert.equal(r.status, 0, r.stderr);
  const files = caps(home);
  assert.equal(files.length, 1);
  const txt = fs.readFileSync(path.join(home, 'captures', files[0]), 'utf8');
  assert.ok(!txt.includes('123e4567'), 'session id redacted');
  assert.ok(!txt.includes('/Users/someone'), 'path redacted');
  assert.ok(!txt.includes('a@b.com'), 'email redacted');
  const saved = JSON.parse(txt);
  assert.equal(saved.classification.kind, 'session');
  assert.equal(saved.source, 'hook');
});
test('capture hook exits 0 on garbage stdin and still saves something', () => {
  const home = tmpDir('limits-home-');
  const r = run(['hook'], { input: 'not json', home });
  assert.equal(r.status, 0);
  assert.equal(caps(home).length, 1);
});
function fakeClaude(stdout, status) {
  const bin = tmpDir('limits-bin-');
  fs.writeFileSync(path.join(bin, 'out.txt'), stdout);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$*" > "${bin}/args.txt"\ncat "${bin}/out.txt"\nexit ${status}\n`, { mode: 0o755 });
  return bin;
}
test('capture wrap passes args, relays output and exit code, saves on is_error', () => {
  const home = tmpDir('limits-home-');
  const bin = fakeClaude(JSON.stringify(fx('session-text.json')), 1);
  const r = run(['wrap', '--', '-p', 'hi', '--output-format', 'json'], { home, bin });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).is_error, true);
  assert.equal(fs.readFileSync(path.join(bin, 'args.txt'), 'utf8').trim(), '-p hi --output-format json');
  const files = caps(home);
  assert.equal(files.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'captures', files[0]), 'utf8'));
  assert.equal(saved.classification.kind, 'session');
  assert.equal(saved.source, 'wrap');
});
test('capture wrap saves nothing on success', () => {
  const home = tmpDir('limits-home-');
  const bin = fakeClaude(JSON.stringify(fx('success.json')), 0);
  const r = run(['wrap', '--', '-p', 'hi', '--output-format', 'json'], { home, bin });
  assert.equal(r.status, 0);
  assert.equal(caps(home).length, 0);
});
test('capture wrap handles stream-json lines', () => {
  const home = tmpDir('limits-home-');
  const bin = fakeClaude(fx('session-event.json').map((e) => JSON.stringify(e)).join('\n'), 1);
  const r = run(['wrap', '--', '-p', 'hi', '--output-format', 'stream-json', '--verbose'], { home, bin });
  assert.equal(r.status, 1);
  assert.equal(caps(home).length, 1);
});
