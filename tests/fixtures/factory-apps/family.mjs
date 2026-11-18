// Fixture: parent plus a same-group (non-detached) grandchild that holds PORT. CHILD_PID_FILE gets the grandchild pid.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'nolog.mjs')], { stdio: 'ignore', env: process.env });
fs.writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));
setInterval(() => {}, 1000);
