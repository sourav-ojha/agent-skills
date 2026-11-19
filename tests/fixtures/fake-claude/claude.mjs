#!/usr/bin/env node
// Fake `claude -p` for tests. Never contacts anything. Writes realistic stream-json events to stdout.
// Config: FAKE_CLAUDE_* env vars, else <FAKE_CLAUDE_DIR>/fake.json (the shim sets FAKE_CLAUDE_DIR to the directory it was
// invoked from, so a test can drive the fake through a scrubbed environment by symlinking the shim into a temp dir).
// Keys: mode, feature, log, bigBytes, chunks ([{b64, delayMs}] for mode "script"), resultText.
// The log (FAKE_CLAUDE_LOG / log) records argv, stdin status and env KEY NAMES only, never env values.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const fromFile = (() => {
  const dir = process.env.FAKE_CLAUDE_DIR;
  if (!dir) return {};
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'fake.json'), 'utf8')); } catch { return {}; }
})();
const cfg = {
  mode: process.env.FAKE_CLAUDE_MODE ?? fromFile.mode ?? 'done',
  feature: process.env.FAKE_CLAUDE_FEATURE ?? fromFile.feature ?? 'FEATURE-001',
  log: process.env.FAKE_CLAUDE_LOG ?? fromFile.log,
  bigBytes: Number(fromFile.bigBytes ?? 50 * 1024 * 1024),
  chunks: fromFile.chunks ?? [],
  resultText: fromFile.resultText,
};

const SID = '00000000-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stdinStatus() {
  const st = fs.fstatSync(0);
  let devNull = false;
  try { const dn = fs.statSync('/dev/null'); devNull = st.isCharacterDevice() && st.rdev === dn.rdev; } catch { /* keep false */ }
  return { devNull, fifo: st.isFIFO(), tty: Boolean(process.stdin.isTTY) };
}

function record(extra = {}) {
  if (!cfg.log) return;
  // TMPDIR is recorded as a hash only (never env values).
  const entry = { argv: process.argv.slice(2), stdin: stdinStatus(), envKeys: Object.keys(process.env).sort(), tmpdirHash: createHash('sha256').update(String(process.env.TMPDIR)).digest('hex'), cwd: process.cwd(), pid: process.pid, pgid: null, ...extra };
  fs.appendFileSync(cfg.log, JSON.stringify(entry) + '\n');
}

const out = (o) => new Promise((r) => { if (!process.stdout.write(JSON.stringify(o) + '\n')) process.stdout.once('drain', r); else r(); });
const usage = { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 300, cache_read_input_tokens: 9000, server_tool_use: { web_search_requests: 0 }, service_tier: 'standard' };
const init = () => out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: SID, tools: ['Read', 'Edit', 'Bash'], mcp_servers: [], model: 'claude-test', permissionMode: 'acceptEdits', apiKeySource: 'none' });
const assistant = (id, text) => out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }], usage: { input_tokens: 60, output_tokens: 20, cache_creation_input_tokens: 150, cache_read_input_tokens: 4500 } }, parent_tool_use_id: null, session_id: SID });
const rate = (status, extra = {}) => out({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1900000000, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false, ...extra }, session_id: SID });
const result = (o = {}) => out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, duration_api_ms: 1000, num_turns: 2, result: cfg.resultText ?? 'finished', session_id: SID, total_cost_usd: 0.0123, usage, api_error_status: null, terminal_reason: 'completed', ...o });

function writeResult(obj) {
  const dir = path.join(process.cwd(), '.implementation', cfg.feature);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(obj));
}

async function main() {
  record();
  switch (cfg.mode) {
    case 'done':
    case 'blocked': {
      await init(); await assistant('msg_1', 'working'); await rate('allowed'); await assistant('msg_1', 'working');
      await assistant('msg_2', 'done');
      writeResult(cfg.mode === 'done' ? { status: 'done', summary: 'implemented' } : { status: 'blocked', question: 'Which database?', summary: 'stopped' });
      await result();
      return 0;
    }
    case 'echo-argv': { await init(); await result({ num_turns: 1 }); return 0; }
    case 'no-result': { await init(); await assistant('msg_1', 'working'); return 1; }
    case 'malformed-stream': {
      process.stdout.write('not json at all\n{"type":"result", broken\n[1,2,3]\n"str"\n{"type":"result","subtype":"success"');
      return 0;
    }
    case 'usage-limit': {
      await init(); await rate('allowed'); await assistant('msg_1', 'working');
      await result({ is_error: true, api_error_status: 429, result: "You've hit your session limit \u00b7 resets 3:45pm", terminal_reason: 'api_error' });
      return 1;
    }
    case 'rejected-rate-event': {
      await init(); await rate('rejected');
      await result({ is_error: true, result: 'API Error', terminal_reason: 'api_error' });
      return 1;
    }
    case 'max-turns-error': { await init(); await assistant('msg_1', 'x'); await result({ subtype: 'error_max_turns', is_error: true, result: undefined }); return 1; }
    case 'rejected-then-error': {
      // A rejected rate event earlier in the stream, then an unrelated execution failure.
      await init(); await rate('rejected'); await assistant('msg_1', 'x');
      await result({ subtype: 'error_during_execution', is_error: true, result: 'tool crashed', terminal_reason: 'error' });
      return 1;
    }
    case 'max-turns': { await init(); await assistant('msg_1', 'x'); await result({ subtype: 'error_max_turns', is_error: false }); return 1; }
    case 'timeout': {
      await init();
      process.on('SIGTERM', () => process.exit(143));
      await sleep(600000);
      return 0;
    }
    case 'sleep-forever': {
      await init();
      process.on('SIGTERM', () => { /* ignored on purpose: the runner must SIGKILL */ });
      const gc = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      record({ grandchild: gc.pid });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
      return 0;
    }
    case 'orphan-on-exit': {
      // Leaves a TERM-ignoring child in the process group and exits normally: the runner must sweep the group.
      const gc = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
      record({ grandchild: gc.pid });
      gc.unref();
      await init(); await result();
      return 0;
    }
    case 'big-output': {
      await init();
      const chunk = 'x'.repeat(1024 * 1024);
      process.stdout.write('{"type":"assistant","pad":"');
      for (let i = 0; i < Math.ceil(cfg.bigBytes / chunk.length); i++) {
        if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once('drain', r));
      }
      process.stdout.write('"}\n');
      await result();
      return 0;
    }
    case 'script': {
      for (const c of cfg.chunks) {
        if (c.delayMs) await sleep(c.delayMs);
        const buf = Buffer.from(c.b64, 'base64');
        if (!process.stdout.write(buf)) await new Promise((r) => process.stdout.once('drain', r));
      }
      return fromFile.exitCode ?? 0;
    }
    default:
      process.stderr.write('fake-claude: unknown mode\n');
      return 2;
  }
}

main().then((code) => { process.stdout.write('', () => process.exit(code)); });
