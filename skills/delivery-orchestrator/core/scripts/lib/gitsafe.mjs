// Hardened git for the driver: fixed argv (never a shell), repo hooks/fsmonitor/pager/external diff disabled, GIT_* environment scrubbed.
// Returns the RAW result: stdout is not trimmed and the real exit code is kept (checkDiff needs exact full-context diffs).
import { spawnSync } from 'node:child_process';

// Every key below is accepted by git 2.52 (checked with `git -c ... log -1`). Command-line -c beats repo-local config.
export const GIT_SAFE_FLAGS = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', // planted .git/hooks never run
  '-c', 'core.fsmonitor=false', // a repo-configured fsmonitor command never runs
  '-c', 'core.sshCommand=ssh', // a repo-configured ssh wrapper never runs
  '-c', 'protocol.ext.allow=never', // ext:: remote URLs cannot run commands
  '-c', 'core.pager=cat', // no repo-configured pager
  // `-c diff.external=` is NOT used: git 2.52 then tries to exec "" and every `git diff` dies ("cannot run :"). Config cannot be unset
  // with -c, so diff/log/show get --no-ext-diff --no-textconv instead (DIFF_GUARD below).
]);
const DIFF_CMDS = new Set(['diff', 'log', 'show']);
const DIFF_GUARD = ['--no-ext-diff', '--no-textconv'];
const MAX_BUFFER = 128 * 1024 * 1024;

// Process env minus every GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG*, GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, GIT_ASKPASS, ...), then pinned values.
export function gitEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^GIT_/i.test(k)) env[k] = String(v);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

export function gitSafe(cwd, ...args) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('gitSafe: cwd is required');
  for (const a of args) if (typeof a !== 'string') throw new Error('gitSafe: every argument must be a string');
  const argv = DIFF_CMDS.has(args[0]) ? [args[0], ...DIFF_GUARD, ...args.slice(1)] : args;
  const r = spawnSync('git', [...GIT_SAFE_FLAGS, ...argv], { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: MAX_BUFFER, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { code: r.status ?? 1, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error.message}` };
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
