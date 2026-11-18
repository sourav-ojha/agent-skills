// Fixture: healthy but ignores SIGTERM (needs SIGKILL).
import http from 'node:http';
process.on('SIGTERM', () => {});
http.createServer((req, res) => { res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('stubborn up'));
