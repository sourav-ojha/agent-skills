// Fixture: spawns a detached, unref'd child that keeps the port, then exits (the child escapes the process group).
// If CHILD_PID_FILE is set the child's pid is written there so tests can clean it up.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'nolog.mjs')], { detached: true, stdio: 'ignore', env: process.env });
child.unref();
if (process.env.CHILD_PID_FILE) fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
