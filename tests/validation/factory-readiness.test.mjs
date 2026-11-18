// factory readiness: config keys app / tests / readiness (strict parsing, local-only URLs, argv commands).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const c = await import(path.join(SK, 'core', 'scripts', 'lib', 'config.mjs'));

test('config: app/tests/readiness parse with defaults', () => {
  const { config, errors } = c.parseConfig({ app: { start: ['npm','run','dev'], ready: { url: 'http://localhost:3000/health', timeout_s: 120 } }, tests: { all: ['npm','test'] }, readiness: { min_level: 4 } });
  assert.deepEqual(errors, []);
  assert.equal(config.readiness.min_level, 4); assert.equal(config.readiness.max_age_days, 14);
  assert.equal(config.tests.timeout_s, 900);
  assert.deepEqual(config.app.start, ['npm','run','dev']);
  assert.equal(config.app.ready.timeout_s, 120);
});
test('config: defaults for app/tests/readiness', () => {
  const d = c.defaults();
  assert.deepEqual(d.app, { setup: null, start: null, stop: null, base_url: null, ready: null, logs_dir: null, seed: null, env_example: null });
  assert.deepEqual(d.tests, { setup: null, all: null, timeout_s: 900 });
  assert.equal(d.readiness, null);
});
test('config: readiness absent means not opted in', () => assert.equal(c.parseConfig({}).config.readiness, null));
test('config: rejects non-local ready url, shell strings, unknown keys, bad bounds', () => {
  for (const raw of [
    { app: { ready: { url: 'http://example.com:80/' } } },
    { app: { start: 'npm run dev' } },
    { app: { foo: 1 } },
    { app: { ready: { url: 'http://localhost:3000', log_pattern: 'x' } } },  // exactly one of url / log_pattern
    { app: { ready: { timeout_s: 10 } } },
    { app: { ready: { log_pattern: '(' } } },
    { app: { base_url: 'https://localhost:3000' } },
    { app: { logs_dir: '../x' } }, { app: { env_example: '/etc/passwd' } },
    { readiness: { min_level: 5 } }, { readiness: { max_age_days: 0 } },
    { tests: { timeout_s: 4000 } },
  ]) assert.ok(c.parseConfig(raw).errors.length, JSON.stringify(raw));
});
test('config: ready accepts log_pattern and base_url/logs_dir', () => {
  const { config, errors } = c.parseConfig({ app: { base_url: 'http://127.0.0.1:8080', logs_dir: '.logs', ready: { log_pattern: 'listening on \\d+' } } });
  assert.deepEqual(errors, []);
  assert.equal(config.app.ready.timeout_s, 120);
  assert.equal(config.app.ready.log_pattern, 'listening on \\d+');
});
test('isLocalUrl: only http localhost / 127.0.0.1 with a port', () => {
  for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080/health']) assert.equal(c.isLocalUrl(u), true, u);
  for (const u of ['http://localhost', 'https://localhost:3000', 'http://example.com:80', ['http://localhost:3000', 'evil.com'].join('@'), 'http://localhost.evil.com:3000', '']) assert.equal(c.isLocalUrl(u), false, u);
});
