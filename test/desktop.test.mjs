// The Windows app runs the engine without a server: API calls in-process (AppServer.call), the interface read from
// the app's files (staticFile), events to subscribers (listeners). Nothing listens on a port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTmp } from './fixtures/tmp.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-desktop-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });
const { startDesktopEngine } = await import('../src/app.mjs');
const { DESKTOP_CSP } = await import('../src/server.mjs');
const { loadCatalog } = await import('../src/engine/catalog.mjs');
const eng = await startDesktopEngine();
after(async () => {
  await loadCatalog(); // the engine's model catalog fetch writes into TMP; let it finish before TMP is removed
  await eng.stop();
  rmTmp(TMP);
});

test('no port: the engine does not listen', () => {
  assert.equal(eng.server.server.listening, false);
  assert.equal(eng.server.port, undefined);
});

test('API calls run in-process and answer like the HTTP API', async () => {
  const st = await eng.server.call('GET', '/api/state');
  assert.equal(st.ok, true);
  assert.ok(st.app?.version);
  const bad = await eng.server.call('GET', '/api/nope');
  assert.deepEqual([bad.ok, bad.status], [false, 404]);
  const err = await eng.server.call('POST', '/api/workspaces', {});
  assert.deepEqual([err.ok, err.status], [false, 400]);
  assert.equal((await eng.server.call('GET', '/api/events')).status, 404); // events go to listeners instead
});

test('the interface comes from the app files, never outside them', () => {
  const idx = eng.server.staticFile('/');
  assert.equal(idx.status, 200);
  assert.match(idx.type, /text\/html/);
  assert.match(String(idx.body), /<html/i);
  assert.equal(eng.server.staticFile('/js/api.js').status, 200);
  assert.equal(eng.server.staticFile('/../package.json').status, 403);
  assert.equal(eng.server.staticFile('/%2e%2e/package.json').status, 403);
  assert.equal(eng.server.staticFile('/nope.js').status, 404);
  assert.match(DESKTOP_CSP, /default-src 'self'/);
  assert.match(DESKTOP_CSP, /script-src 'self'(;|$)/);
});

test('events reach in-process listeners', () => {
  const seen = [];
  const fn = (m) => seen.push(m);
  eng.server.listeners.add(fn);
  eng.server.broadcast({ g: 'procs', procs: [] });
  eng.server.listeners.delete(fn);
  assert.deepEqual(seen, [{ g: 'procs', procs: [] }]);
});

test('OpenRouter sign-in opens a callback listener only for the sign-in', async () => {
  const port = await eng.server.callbackPort();
  assert.ok(port > 0);
  const other = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(other.status, 404);
  assert.equal(await eng.server.callbackPort(), port);
});

test('skills: add one for a project and one for every project, read, edit, delete to the trash', async () => {
  const ws = path.join(TMP, 'proj');
  fs.mkdirSync(ws, { recursive: true });
  const call = (m, p, b, q) => eng.server.call(m, p, b, q);
  assert.equal((await call('POST', '/api/skills/save', { ws, scope: 'project', name: 'Release Notes', description: 'Use for release notes', body: '1. Read the log.' })).ok, true);
  assert.equal((await call('POST', '/api/skills/save', { ws, scope: 'user', name: 'review', description: 'Use to review a diff', body: 'Check it.' })).ok, true);
  const dup = await call('POST', '/api/skills/save', { ws, scope: 'project', name: 'release notes', description: 'x', body: 'y' });
  assert.deepEqual([dup.ok, dup.status], [false, 409]);
  assert.equal((await call('POST', '/api/skills/save', { ws, name: 'x', description: '', body: 'y' })).status, 400);
  const list = (await call('GET', '/api/skills', {}, { ws })).skills;
  assert.deepEqual(list.map((k) => [k.name, k.scope]), [['release-notes', 'project'], ['review', 'user']]);
  assert.ok(fs.existsSync(path.join(ws, '.agents', 'skills', 'release-notes', 'SKILL.md')));
  const file = await call('GET', '/api/skills/file', {}, { ws, name: 'release-notes' });
  assert.deepEqual([file.description, file.body.trim()], ['Use for release notes', '1. Read the log.']);
  await call('POST', '/api/skills/save', { ws, original: 'release-notes', description: 'Use for changelogs', body: 'New steps.' });
  assert.equal((await call('GET', '/api/skills/file', {}, { ws, name: 'release-notes' })).description, 'Use for changelogs');
  const del = await call('POST', '/api/skills/delete', { ws, name: 'release-notes' });
  assert.equal(del.ok, true);
  assert.ok(fs.existsSync(path.join(del.trashed, 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(ws, '.agents', 'skills', 'release-notes')));
  assert.deepEqual(del.skills.map((k) => k.name), ['review']);
});
