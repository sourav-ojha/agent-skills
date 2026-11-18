// Fixture: ready only on odd starts. COUNTER_FILE is incremented on each start; /health is 200 only when it is odd.
import http from 'node:http';
import fs from 'node:fs';
const f = process.env.COUNTER_FILE;
let n = 0;
try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch {}
n += 1;
fs.writeFileSync(f, String(n));
http.createServer((req, res) => { res.statusCode = n % 2 === 1 ? 200 : 503; res.end('x'); }).listen(Number(process.env.PORT), '127.0.0.1');
