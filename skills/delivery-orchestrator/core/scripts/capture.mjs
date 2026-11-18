#!/usr/bin/env node
// Passive capture of failure payloads (P0.3). Zero dependencies; argv only, never a shell.
//   capture.mjs hook                      read a StopFailure hook payload on stdin
//   capture.mjs wrap -- <claude args...>  run `claude <args>`, relay output and exit code, save on is_error
// Redacted payloads go to FACTORY_HOME/captures/<timestamp>.json. Capture never changes the exit code of the wrapped run
// and the hook always exits 0.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyFailure } from './lib/limits.mjs';
import { factoryHome, writeJsonAtomic } from './lib/factoryhome.mjs';
import { redact } from './lib/proc.mjs';

const deepRedact = (v) => {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(deepRedact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepRedact(x)]));
  return v;
};

function parseAny(text) {
  try { return JSON.parse(text); } catch { /* maybe JSON lines */ }
  const objs = [];
  for (const l of text.split('\n')) { try { const o = JSON.parse(l); if (o && typeof o === 'object') objs.push(o); } catch { /* skip */ } }
  return objs.length ? objs : text;
}

export function saveCapture(source, payload, extra = {}) {
  const classification = classifyFailure(payload);
  const dir = path.join(factoryHome(), 'captures');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${process.pid}.json`);
  writeJsonAtomic(file, { source, captured_at: new Date().toISOString(), classification, ...extra, payload: deepRedact(payload) });
  return file;
}

const isError = (p) => (Array.isArray(p) ? p : [p]).some((e) => e && typeof e === 'object' && (e.is_error === true || e.hook_event_name === 'StopFailure'));

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'hook') {
    let input = '';
    try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    try { saveCapture('hook', parseAny(input)); } catch (e) { process.stderr.write(`capture: ${e.message}\n`); }
    return 0;
  }
  if (mode === 'wrap') {
    const args = rest[0] === '--' ? rest.slice(1) : rest;
    const r = spawnSync('claude', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['inherit', 'pipe', 'inherit'] });
    if (r.error) { process.stderr.write(`capture: cannot run claude: ${r.error.message}\n`); return 127; }
    process.stdout.write(r.stdout || '');
    const payload = parseAny(r.stdout || '');
    if (isError(payload)) {
      try { saveCapture('wrap', payload, { exit_code: r.status }); } catch (e) { process.stderr.write(`capture: ${e.message}\n`); }
    }
    return r.status ?? 1;
  }
  process.stderr.write('usage: capture.mjs hook | capture.mjs wrap -- <claude args...>\n');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
