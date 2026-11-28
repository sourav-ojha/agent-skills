// API scenario checks run by the driver against the app under test. Zero dependencies.
// Trust: the app is built from untrusted feature-branch code and the scenario file is LLM-authored. So:
// - only http://localhost or http://127.0.0.1 base URLs; request paths are relative ("/..."), printable ASCII, no "//", "\" or "#";
// - scenario headers are restricted (token names, no CR/LF/control characters, no Host / framing / hop-by-hop headers);
// - redirects are never followed (redirect: 'manual'; the 3xx is the response);
// - one monotonic budget per scenario covers every request, every body read and every regex; each request has an AbortController;
// - response bodies are stream-read and abandoned once they pass maxBodyBytes;
// - `failed` names the step or assertion kind only ("setup", "request", "response", "status", "header", "json_path"):
//   never a path, header value, body or pattern, because it can reach builder-visible output.
// ReDoS: JavaScript regexes backtrack and cannot be interrupted in-thread, so length caps alone do not bound the work. A
// `matches` pattern (max MAX_PATTERN chars, no flags) is first compiled in-process (compiling is linear), then run in a
// short-lived worker thread that is terminated after regexTimeoutMs; a timeout makes the assertion `blocked`. Subjects longer
// than MAX_SUBJECT chars are not truncated (a truncated subject can match where the full one would not); they fail.
// The text and json_path evaluation is shared with cli scenarios (clicheck.mjs) through textCheck, with the same limits and worker.
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { validAssertion, validCliAssertion } from './scenarios.mjs';

const MAX_PATH_EXPR = 256;
const MAX_SEGMENTS = 32;
const MAX_INDEX_DIGITS = 6;
const MAX_PATTERN = 256;
const MAX_SUBJECT = 64 * 1024;
const MAX_ASSERTS = 100;
const MAX_SETUP = 20;
const MAX_HEADERS = 32;
const MAX_URL_PATH = 2048;
const MAX_REQ_BODY = 256 * 1024;
const MAX_EQ_DEPTH = 100;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const DENIED_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'keep-alive', 'expect', 'proxy-authorization', 'proxy-connection', 'http2-settings']);
const HEADER_VALUE = /^[\t\x20-\x7e]{0,4096}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const KEY = /^[A-Za-z0-9_-]+/;

const unsupported = () => new Error('unsupported json_path');

// Parse "$", ".key", "[n]", "[*]" only. Returns segments [{ key } | { index } | { all: true }].
function parsePath(expr) {
  if (typeof expr !== 'string' || expr.length > MAX_PATH_EXPR || expr[0] !== '$') throw unsupported();
  const segs = [];
  let i = 1;
  while (i < expr.length) {
    if (segs.length >= MAX_SEGMENTS) throw unsupported();
    if (expr[i] === '.') {
      const m = KEY.exec(expr.slice(i + 1));
      if (!m || FORBIDDEN_KEYS.has(m[0])) throw unsupported();
      segs.push({ key: m[0] }); i += 1 + m[0].length;
    } else if (expr.startsWith('[*]', i)) {
      segs.push({ all: true }); i += 3;
    } else if (expr[i] === '[') {
      const m = /^\[(0|[1-9]\d*)\]/.exec(expr.slice(i));
      if (!m || m[1].length > MAX_INDEX_DIGITS) throw unsupported();
      segs.push({ index: Number(m[1]) }); i += m[0].length;
    } else throw unsupported();
  }
  return segs;
}

// True when the json_path expression parses (scenarios.mjs lint and the runner must agree on this).
export function jsonPathParses(expr) { try { parsePath(expr); return true; } catch { return false; } }

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Own properties only: `.key` on plain objects, `[n]` on arrays, `[*]` over own values of either.
// `resolved` is false when any step drops a value: a `.key` or `[n]` that is absent, or a `[*]` over a non-container.
// A `[*]` over an empty container is resolved (an empty list is a real answer; a typo is not).
function walk(obj, expr) {
  let cur = [obj]; let resolved = true;
  for (const s of parsePath(expr)) {
    const next = [];
    for (const v of cur) {
      if ('key' in s) { if (isPlainObject(v) && Object.hasOwn(v, s.key)) next.push(v[s.key]); else resolved = false; }
      else if ('index' in s) { if (Array.isArray(v) && s.index < v.length) next.push(v[s.index]); else resolved = false; }
      else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) next.push(v[i]);
      else if (isPlainObject(v)) for (const k of Object.keys(v)) next.push(v[k]);
      else resolved = false;
    }
    cur = next;
  }
  return { values: cur, resolved };
}
export const jsonPath = (obj, expr) => walk(obj, expr).values;

function deepEqual(a, b, d = 0) {
  if (d > MAX_EQ_DEPTH) return false;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i], d + 1));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k], d + 1));
  }
  return false;
}
const containsOne = (m, v) => deepEqual(m, v)
  || (typeof m === 'string' && typeof v === 'string' && m.includes(v))
  || (Array.isArray(m) && m.some((e) => deepEqual(e, v)));

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const re = new RegExp(workerData.pattern);
parentPort.postMessage(workerData.subjects.map((s) => re.test(s)));
`;
class Timeout extends Error {}
class TooLarge extends Error {}

// true only if every subject matches. Throws on an invalid pattern or a timeout.
async function allMatch(pattern, subjects, ms) {
  new RegExp(pattern); // syntax check in-process (linear); throws SyntaxError
  if (!subjects.length || subjects.some((s) => typeof s !== 'string')) return false;
  if (subjects.some((s) => s.length > MAX_SUBJECT)) return false;
  if (ms <= 0) throw new Timeout('regex budget exhausted');
  const w = new Worker(WORKER_SRC, { eval: true, workerData: { pattern, subjects }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
  let t;
  try {
    const out = await new Promise((resolve, reject) => {
      t = setTimeout(() => reject(new Timeout('regex timeout')), ms);
      w.once('message', resolve);
      w.once('error', reject);
      w.once('exit', (c) => reject(new Error(`regex worker exited ${c}`)));
    });
    return Array.isArray(out) && out.length === subjects.length && out.every((x) => x === true);
  } finally { clearTimeout(t); w.terminate(); }
}

// One `json_path` op on an already parsed value. Shared by api assertions and cli text checks (textCheck). `ms` is a function
// returning the regex budget at the moment the regex runs. Throws on an invalid pattern or a regex timeout.
async function jsonPathOp(parsed, a, op, ms) {
  const { values: m, resolved } = walk(parsed, a.json_path);
  const v = a[op];
  if ((op === 'not_contains' || op === 'count') && !resolved) return false; // a typo or an error body must not pass vacuously
  if (op === 'equals') return m.length > 0 && m.every((x) => deepEqual(x, v));
  if (op === 'contains') return m.some((x) => containsOne(x, v));
  if (op === 'not_contains') return !m.some((x) => containsOne(x, v));
  if (op === 'count') return (!a.json_path.includes('[*]') && m.length === 1 && Array.isArray(m[0]) ? m[0].length : m.length) === v;
  return allMatch(v, m, ms());
}

// Throws unless `check` is a cli text check (scenarios.mjs validCliAssertion) this engine can run: a supported json_path, a
// non-negative integer count, a pattern of at most MAX_PATTERN characters. Returns the op name.
export function prepareTextCheck(check) {
  const bad = () => new Error('invalid text check');
  if (!validCliAssertion({ stdout: check })) throw bad();
  if (!('json_path' in check)) {
    const [op] = Object.keys(check);
    if (op === 'matches' && check.matches.length > MAX_PATTERN) throw bad();
    return op;
  }
  parsePath(check.json_path);
  const op = Object.keys(check).find((k) => k !== 'json_path');
  if (op === 'count' && !(Number.isInteger(check.count) && check.count >= 0)) throw bad();
  if (op === 'matches' && (typeof check.matches !== 'string' || check.matches.length > MAX_PATTERN)) throw bad();
  return op;
}

// A cli text check on a whole text (stdout, stderr or a file's UTF-8 contents): `equals`, `contains`, `not_contains` or `matches`
// on the text, or `json_path` + one op on the text parsed as JSON. Text that does not parse fails (false). Resolves a boolean;
// rejects on an invalid check, an invalid pattern or a regex timeout (the caller makes that `blocked`). `matches` runs in the same
// time-limited worker as api assertions; a subject over MAX_SUBJECT characters fails (never truncated).
export async function textCheck(text, check, { regexTimeoutMs = 500 } = {}) {
  const op = prepareTextCheck(check);
  if (typeof text !== 'string') return false;
  const ms = () => regexTimeoutMs;
  if ('json_path' in check) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return false; }
    return jsonPathOp(parsed, check, op, ms);
  }
  const v = check[op];
  if (op === 'equals') return text === v;
  if (op === 'contains') return text.includes(v);
  if (op === 'not_contains') return !text.includes(v);
  return allMatch(v, [text], ms());
}

function checkBaseUrl(baseUrl) {
  const err = () => new Error('base URL must be http://localhost or http://127.0.0.1 with an optional port and no path');
  let u;
  try { u = new URL(String(baseUrl)); } catch { throw err(); }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw err();
  // "localhost" may resolve to ::1 first, where another local process could answer: always connect to 127.0.0.1.
  return `http://127.0.0.1${u.port ? `:${u.port}` : ''}`;
}

// Build fetch input for one scenario request. Returns null when the request shape is not acceptable.
function buildRequest(r, origin) {
  if (!isPlainObject(r)) return null;
  const { method, path: p, headers, body } = r;
  if (typeof method !== 'string' || !METHODS.has(method)) return null;
  if (typeof p !== 'string' || p.length < 1 || p.length > MAX_URL_PATH || p[0] !== '/' || p.includes('//') || !/^[\x21-\x7e]+$/.test(p) || /[\\#]/.test(p)) return null;
  let url;
  try { url = new URL(p, `${origin}/`); } catch { return null; }
  if (url.origin !== origin) return null;
  const h = Object.create(null);
  if (headers !== undefined) {
    if (!isPlainObject(headers)) return null;
    const names = Object.keys(headers);
    if (names.length > MAX_HEADERS) return null;
    for (const n of names) {
      const v = headers[n];
      if (!TOKEN.test(n) || FORBIDDEN_KEYS.has(n.toLowerCase()) || DENIED_HEADERS.has(n.toLowerCase()) || /^(proxy-|sec-)/i.test(n) || typeof v !== 'string' || !HEADER_VALUE.test(v)) return null;
      if (n.toLowerCase() in h) return null;
      h[n.toLowerCase()] = v;
    }
  }
  let payload;
  if (body !== undefined) {
    try { payload = JSON.stringify(body); } catch { return null; }
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_REQ_BODY) return null;
    if (method === 'GET' || method === 'HEAD') return null;
    if (!('content-type' in h)) h['content-type'] = 'application/json';
  }
  return { url: url.href, init: { method, headers: h, ...(payload !== undefined ? { body: payload } : {}) } };
}

async function readCapped(res, max) {
  const cl = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(cl) && cl > max) { await res.body?.cancel().catch(() => {}); throw new TooLarge(); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = []; let n = 0; let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) { done = true; break; }
      n += r.value.byteLength;
      if (n > max) throw new TooLarge();
      chunks.push(r.value);
    }
  } finally { if (!done) reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

// One request under the scenario deadline: abort on timeout, never follow redirects, cap the body.
async function send(fetchImpl, req, deadline, maxBodyBytes) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Timeout();
  const ac = new AbortController();
  let t;
  const timeout = new Promise((_, reject) => { t = setTimeout(() => { ac.abort(); reject(new Timeout()); }, remaining); });
  timeout.catch(() => {});
  try {
    const res = await Promise.race([fetchImpl(req.url, { ...req.init, redirect: 'manual', signal: ac.signal }), timeout]);
    if (!res || typeof res.status !== 'number') throw new Error('no response');
    const body = await Promise.race([readCapped(res, maxBodyBytes), timeout]);
    return { res, body };
  } finally { clearTimeout(t); ac.abort(); }
}

// Validate every assertion before any request: unsupported json_path / unrecognised shapes are programming errors.
function prepareAssertions(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ASSERTS) throw new Error('invalid assertion list');
  return list.map((a, i) => {
    if (!validAssertion(a)) throw new Error(`invalid assertion #${i + 1}`);
    if ('status' in a) return { kind: 'status', a };
    if ('header' in a) {
      if (!TOKEN.test(a.header)) throw new Error(`invalid assertion #${i + 1}`);
      if ('matches' in a && a.matches.length > MAX_PATTERN) throw new Error(`invalid assertion #${i + 1}`);
      return { kind: 'header', a };
    }
    parsePath(a.json_path);
    const op = Object.keys(a).find((k) => k !== 'json_path');
    if (op === 'count' && !(Number.isInteger(a.count) && a.count >= 0)) throw new Error(`invalid assertion #${i + 1}`);
    if (op === 'matches' && (typeof a.matches !== 'string' || a.matches.length > MAX_PATTERN)) throw new Error(`invalid assertion #${i + 1}`);
    return { kind: 'json_path', a, op };
  });
}

export async function runApiScenario(scenario, baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 10000, regexTimeoutMs = 500, maxBodyBytes = 1024 * 1024 } = {}) {
  const origin = checkBaseUrl(baseUrl);
  if (!isPlainObject(scenario) || scenario.kind !== 'api') throw new Error('not an api scenario');
  const asserts = prepareAssertions(scenario.assert);
  const deadline = performance.now() + timeoutMs;
  const blocked = (failed) => ({ status: 'blocked', failed });

  if (scenario.setup !== undefined) {
    if (!Array.isArray(scenario.setup) || scenario.setup.length > MAX_SETUP) return blocked('setup');
    for (const s of scenario.setup) {
      const req = buildRequest(s, origin);
      if (!req) return blocked('setup');
      try {
        const { res } = await send(fetchImpl, req, deadline, maxBodyBytes);
        if (res.status < 200 || res.status > 299) return blocked('setup');
      } catch { return blocked('setup'); }
    }
  }

  const req = buildRequest(scenario.request, origin);
  if (!req) return blocked('request');
  let res; let body;
  try { ({ res, body } = await send(fetchImpl, req, deadline, maxBodyBytes)); } catch (e) { return blocked(e instanceof TooLarge ? 'response' : 'request'); }

  let parsed; let parseOk = null;
  const json = () => {
    if (parseOk === null) { try { parsed = JSON.parse(body.toString('utf8')); parseOk = true; } catch { parseOk = false; } }
    return parseOk;
  };
  const regexMs = () => Math.min(regexTimeoutMs, deadline - performance.now());

  for (const { kind, a, op } of asserts) {
    let ok;
    try {
      if (kind === 'status') ok = res.status === a.status;
      else if (kind === 'header') {
        const v = res.headers.get(a.header);
        if (v === null) ok = false;
        else if ('equals' in a) ok = v === a.equals;
        else ok = await allMatch(a.matches, [v], regexMs());
      } else if (!json()) ok = false;
      else ok = await jsonPathOp(parsed, a, op, regexMs);
    } catch { return blocked(kind); }
    if (ok !== true) return { status: 'fail', failed: kind };
  }
  return { status: 'pass' };
}
