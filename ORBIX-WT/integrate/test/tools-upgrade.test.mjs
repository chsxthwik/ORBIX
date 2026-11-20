// Regression tests for the tool and MCP fixes: CRLF-safe single-line edits, grep `$` on CRLF files, the cmd
// multi-line guard, real PowerShell exit codes, Stop after a hook, MCP schema normalisation and ${VAR} expansion.
// No network, no provider keys; ORBIX_DATA points at a temp folder.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-up-'));
process.env.ORBIX_NO_RG = '1'; // the JS search engine, so results do not depend on an installed ripgrep
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });

const { createTools } = await import('../src/engine/tools.mjs');
const { Backend } = await import('../src/backend.mjs');
const { normalizeSchema, expandEnv } = await import('../src/engine/mcp.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const WIN = process.platform === 'win32';

describe('edit and grep on CRLF files', () => {
  const ws = path.join(TMP, 'ws');
  const backend = { hostPath: (p) => p, spawnShell: (command, { cwd }) => spawn(command, { cwd, shell: true }) };
  let T;
  before(() => {
    fs.mkdirSync(ws, { recursive: true });
    T = createTools({ backend, cwd: ws, getSignal: () => undefined });
  });
  const run = (name, input) => T.run(name, input, { onUpdate() {} });

  test('a single-line old_string that adds lines keeps the file CRLF throughout', async () => {
    const f = path.join(ws, 'a.txt');
    fs.writeFileSync(f, 'a\r\nb\r\n');
    const r = await run('edit', { path: 'a.txt', old_string: 'a', new_string: 'a\nx' });
    assert.ok(!r.isError, r.text);
    assert.equal(fs.readFileSync(f, 'utf8'), 'a\r\nx\r\nb\r\n');
  });

  test('a single-line edit on an LF file stays LF', async () => {
    const f = path.join(ws, 'b.txt');
    fs.writeFileSync(f, 'a\nb\n');
    await run('edit', { path: 'b.txt', old_string: 'a', new_string: 'a\nx' });
    assert.equal(fs.readFileSync(f, 'utf8'), 'a\nx\nb\n');
  });

  test('grep: a pattern ending in $ matches lines of a CRLF file', async () => {
    fs.writeFileSync(path.join(ws, 'c.js'), 'let a = 1;\r\nlet b = 2\r\n');
    const r = await run('grep', { pattern: ';$', path: '.' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /c\.js/);
    assert.match(r.text, /let a = 1;/);
    assert.doesNotMatch(r.text, /let b = 2/);
  });
});

describe('bash on native Windows', { skip: !WIN && 'Windows only' }, () => {
  const ws = path.join(TMP, 'win');
  let T;
  before(() => {
    fs.mkdirSync(ws, { recursive: true });
    T = createTools({ backend: new Backend({ kind: 'native', distro: '' }), cwd: ws, getSignal: () => undefined });
  });
  const run = (input) => T.run('bash', input, { onUpdate() {} });

  test('cmd: a multi-line command is refused before anything runs, with how to fix it', async () => {
    const marker = path.join(ws, 'ran.txt');
    const r = await run({ command: `echo one > "${marker}"\necho two` });
    assert.ok(r.isError);
    assert.match(r.text, /only the first line/);
    assert.match(r.text, /&&/);
    assert.ok(!fs.existsSync(marker), 'the first line must not have run');
  });

  test('cmd: a single-line command with && still runs', async () => {
    const r = await run({ command: 'echo one && echo two' });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /one[\s\S]*two/);
  });

  test('powershell: the exit code of a native program is passed on, not collapsed to 1', async () => {
    const r = await run({ command: 'Write-Output hi; cmd /c exit 7', shell: 'powershell' });
    assert.match(r.text, /hi/);
    assert.match(r.text, /exit code 7/);
  });

  test('powershell: an explicit exit N wins, and success stays 0', async () => {
    assert.match((await run({ command: 'exit 3', shell: 'powershell' })).text, /exit code 3/);
    const ok = await run({ command: 'Write-Output fine', shell: 'powershell' });
    assert.ok(!ok.isError, ok.text);
    assert.match(ok.text, /exit code 0\b/);
  });

  test('powershell: a multi-line script runs every line', async () => {
    const r = await run({ command: 'Write-Output one\nWrite-Output two', shell: 'powershell' });
    assert.match(r.text, /one[\s\S]*two/);
  });
});

describe('MCP: tool schemas providers accept', () => {
  test('a plain object schema passes, minus $schema', () => {
    const s = normalizeSchema({ $schema: 'x', type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
    assert.deepEqual(s, { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  });

  test('missing or non-object schemas become an empty object schema', () => {
    assert.deepEqual(normalizeSchema(undefined), { type: 'object', properties: {} });
    assert.deepEqual(normalizeSchema({ type: 'string' }), { type: 'object', properties: {} });
  });

  test('top-level anyOf / oneOf branches merge into one object; allOf also merges required', () => {
    const any = normalizeSchema({ anyOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } } }] });
    assert.deepEqual(Object.keys(any.properties).sort(), ['a', 'b']);
    assert.equal(any.anyOf, undefined);
    assert.equal(any.required, undefined, 'anyOf branches are alternatives: none of their fields is required');
    const all = normalizeSchema({ allOf: [{ properties: { a: {} }, required: ['a'] }, { properties: { b: {} }, required: ['b'] }] });
    assert.deepEqual(all.required.sort(), ['a', 'b']);
  });

  test('local $refs are inlined and $defs dropped; a cycle stops instead of looping', () => {
    const s = normalizeSchema({ type: 'object', properties: { p: { $ref: '#/$defs/P' } }, $defs: { P: { type: 'object', properties: { name: { type: 'string' } } } } });
    assert.deepEqual(s.properties.p, { type: 'object', properties: { name: { type: 'string' } } });
    assert.equal(s.$defs, undefined);
    const cyc = normalizeSchema({ type: 'object', properties: { n: { $ref: '#/definitions/N' } }, definitions: { N: { type: 'object', properties: { next: { $ref: '#/definitions/N' } } } } });
    assert.equal(cyc.type, 'object');
    assert.ok(JSON.stringify(cyc).length < 20000);
  });

  test('a property name providers reject makes the tool unusable (null), and required keeps only real fields', () => {
    assert.equal(normalizeSchema({ type: 'object', properties: { 'has space': { type: 'string' } } }), null);
    assert.deepEqual(normalizeSchema({ type: 'object', properties: { a: {} }, required: ['a', 'gone'] }).required, ['a']);
  });

  test('a circular schema object returns null instead of throwing', () => {
    const o = { type: 'object', properties: {} };
    o.properties.self = o;
    assert.equal(normalizeSchema(o), null);
  });
});

describe('MCP: ${VAR} expansion in server configs', () => {
  const env = { TOKEN: 'abc', HOST: 'example.com' };
  test('command, args, env, url and headers are expanded; defaults apply; unset becomes empty', () => {
    const cfg = { command: 'npx', args: ['-y', 'srv', '--host=${HOST}'], env: { GITHUB_TOKEN: '${TOKEN}', MODE: '${MODE:-prod}', X: '${NOPE}' }, url: 'https://${HOST}/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } };
    const e = expandEnv(cfg, env);
    assert.deepEqual(e.args, ['-y', 'srv', '--host=example.com']);
    assert.deepEqual(e.env, { GITHUB_TOKEN: 'abc', MODE: 'prod', X: '' });
    assert.equal(e.url, 'https://example.com/mcp');
    assert.equal(e.headers.Authorization, 'Bearer abc');
  });
  test('the original config object is not changed (trust is decided on it as written)', () => {
    const cfg = { command: 'x', env: { T: '${TOKEN}' } };
    expandEnv(cfg, env);
    assert.equal(cfg.env.T, '${TOKEN}');
  });

  test('expanded values are not the same as the written config (restart identity must use the source)', () => {
    const written = { command: 'npx', args: ['-y', 'srv'], headers: { Authorization: 'Bearer ${TOKEN}' } };
    assert.notEqual(JSON.stringify(written), JSON.stringify(expandEnv(written, env)));
  });
});
