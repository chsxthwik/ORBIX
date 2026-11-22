// The Terminal (src/pty.mjs): a shell per terminal, output streamed as events, input and resize, close.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ptys } from '../src/pty.mjs';
import { Backend } from '../src/backend.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-pty-'));
after(async () => { await wait(800); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

test('a terminal runs what you type and streams the output', async () => {
  let out = '';
  const ptys = new Ptys({ backend: new Backend({ kind: 'native' }), emit: (m) => (out += m.out || '') });
  const t = ptys.open(dir, { cols: 100, rows: 30 });
  assert.equal(t.mode, process.platform === 'win32' ? 'line' : 'pty');
  assert.equal(ptys.list(dir).length, 1);
  await wait(1500);
  ptys.resize(t.id, 120, 40);
  ptys.input(t.id, t.mode === 'line' ? 'echo orbix-$(6*7)' : 'echo orbix-$((6*7))\r');
  for (let i = 0; i < 40 && !out.includes('orbix-42'); i++) await wait(150);
  assert.match(out, /orbix-42/);
  assert.throws(() => ptys.input(t.id, 'x'.repeat(200001)), /too much/);
  ptys.closeAll();
  assert.equal(ptys.list(dir).length, 0);
  assert.throws(() => ptys.get(t.id), /closed/);
});

test('no terminal without a project', () => {
  const ptys = new Ptys({ backend: new Backend({ kind: 'native' }), emit: () => {} });
  assert.throws(() => ptys.open(''), /project/);
});
