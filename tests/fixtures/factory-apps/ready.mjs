// Fixture: healthy app. Serves /health 200 on process.env.PORT and writes logs/app.log under cwd.
import http from 'node:http';
import fs from 'node:fs';
fs.mkdirSync('logs', { recursive: true });
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', '/health'); return res.end(); }
  res.statusCode = req.url === '/health' ? 200 : 404;
  res.end(res.statusCode === 200 ? 'ok' : 'nope');
}).listen(port, '127.0.0.1', () => {
  fs.appendFileSync('logs/app.log', `listening on ${port}\n`);
  console.log(`listening on ${port}`);
});
