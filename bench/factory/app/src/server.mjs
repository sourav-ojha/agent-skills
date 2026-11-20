// Task-list JSON API (factory benchmark fixture). No dependencies. Listens on HOST (default 127.0.0.1) and PORT (default 47613);
// PORT=0 picks a free port. Prints "listening on http://<host>:<port>" once it accepts connections.
import http from 'node:http';
import { routes } from './routes.mjs';

const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// "/api/tasks/:id" against "/api/tasks/7" -> { id: "7" }; null when the path does not match.
function match(pattern, pathname) {
  const want = pattern.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) {
      if (!got[i]) return null;
      params[want[i].slice(1)] = decodeURIComponent(got[i]);
    } else if (want[i] !== got[i]) return null;
  }
  return params;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let found = null;
    for (const [method, pattern, handler] of routes) {
      const params = method === req.method ? match(pattern, url.pathname) : null;
      if (params) { found = { handler, params }; break; }
    }
    if (!found) return send(res, 404, { error: 'not_found' });
    const raw = await readBody(req);
    let body;
    if (raw.length) {
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid_json' }); }
    }
    const out = await found.handler({ params: found.params, query: url.searchParams, body });
    return send(res, out.status, out.body);
  } catch {
    return send(res, 500, { error: 'internal' });
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT ?? 47613);
server.listen(port, host, () => {
  console.log(`listening on http://${host}:${server.address().port}`);
});
