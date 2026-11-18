// Fixture: stand-in orchestrator. Starts an app via proc.startApp, reports readiness, then idles until signalled.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { startApp, allowEnv } = await import(path.join(here, '..', '..', '..', 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'proc.mjs'));
startApp(['node', path.join(here, 'nolog.mjs')], { env: { ...allowEnv(null), PORT: process.env.PORT } });
console.log('started');
setInterval(() => {}, 1000);
