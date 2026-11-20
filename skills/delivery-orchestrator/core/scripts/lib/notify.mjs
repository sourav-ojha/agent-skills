// macOS notifications. Carries repo key, event and count only, never feature content. argv only, no shell.
import { spawnSync } from 'node:child_process';

const TEXT = {
  paused: (k, n) => `${k}: run paused (${n} waiting)`,
  stopped: (k, n) => `${k}: run stopped (${n} waiting)`,
  finished: (k, n) => `${k}: run finished (${n} done)`,
  attention: (k, n) => `${k}: ${n} item(s) need attention`,
};

export function notify(event, { key, count } = {}, { run = spawnSync, platform = process.platform } = {}) {
  if (!Object.hasOwn(TEXT, event)) throw new Error(`unknown notification event ${event}`);
  if (!/^[A-Za-z0-9._-]+$/.test(String(key))) throw new Error('invalid repo key for notification');
  const n = Number.isInteger(count) && count >= 0 ? count : 0;
  if (platform !== 'darwin') return false;
  const r = run('osascript', ['-e', `display notification "${TEXT[event](key, n)}" with title "factory"`], { stdio: 'ignore', timeout: 5000 });
  return !!r && r.status === 0;
}
