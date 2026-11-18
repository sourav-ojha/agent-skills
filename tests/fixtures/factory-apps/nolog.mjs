// Fixture: healthy app that writes no log file and prints nothing.
import http from 'node:http';
http.createServer((req, res) => { res.end('ok'); }).listen(Number(process.env.PORT), '127.0.0.1');
