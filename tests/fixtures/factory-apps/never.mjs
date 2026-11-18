// Fixture: listens but never becomes healthy (/health is 503).
import http from 'node:http';
http.createServer((req, res) => { res.statusCode = 503; res.end('starting'); }).listen(Number(process.env.PORT), '127.0.0.1');
