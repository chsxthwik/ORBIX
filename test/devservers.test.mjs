import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { findDevServers, pageTitle, isLocalPage } from '../src/devservers.mjs';

test('pageTitle reads and cleans the title', () => {
  assert.equal(pageTitle('<html><head><title>\n  Shop &amp; Co </title></head>'), 'Shop & Co');
  assert.equal(pageTitle('<p>no title</p>'), '');
});

test('isLocalPage: only http pages on this computer', () => {
  assert.equal(isLocalPage('http://localhost:5173/'), true);
  assert.equal(isLocalPage('http://127.0.0.1:3000/app'), true);
  assert.equal(isLocalPage('https://example.com/'), false);
  assert.equal(isLocalPage('http://192.168.1.4:3000/'), false);
  assert.equal(isLocalPage('file:///C:/x.html'), false);
  assert.equal(isLocalPage('not a url'), false);
});

test('findDevServers lists the ports that answer, with their titles, and skips its own', async () => {
  const srv = http.createServer((_q, r) => (r.writeHead(200, { 'content-type': 'text/html' }), r.end('<title>Vite App</title>')));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  const closed = http.createServer();
  await new Promise((ok) => closed.listen(0, '127.0.0.1', ok));
  const gone = closed.address().port;
  await new Promise((ok) => closed.close(ok));
  try {
    const found = await findDevServers({ ports: [port, gone], timeout: 1000 });
    assert.deepEqual(found, [{ port, url: `http://localhost:${port}/`, status: 200, title: 'Vite App' }]);
    assert.deepEqual(await findDevServers({ ports: [port], skip: [port] }), []);
  } finally {
    srv.close();
  }
});
