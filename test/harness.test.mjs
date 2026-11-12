// The agent harness: line diffs with separate hunks, files outside the project, mixed line endings, a reply cut by
// the token limit, a helper agent that runs out of context, and repeated compaction. No network, no provider keys.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-harness-'));
process.env.ORBIX_NO_RG = '1';
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });

const { createTools } = await import('../src/engine/tools.mjs');
const { runTasks } = await import('../src/engine/subagent.mjs');
const { AgentProc } = await import('../src/engine/proc.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ws = path.join(TMP, 'ws');
const backend = { hostPath: (p) => p, spawnShell: (command, { cwd }) => spawn(command, { cwd, shell: true }) };
let T;
before(() => {
  fs.mkdirSync(ws, { recursive: true });
  T = createTools({ backend, cwd: ws, getSignal: () => undefined });
});

describe('diffs', () => {
  test('two edits far apart are two hunks, not one block of the whole file', async () => {
    const before = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const now = [...before];
    now[10] = 'changed 10';
    now[900] = 'changed 900';
    fs.writeFileSync(path.join(ws, 'long.txt'), now.join('\n'));
    const d = await T.diffSince({ path: path.join(ws, 'long.txt'), before: before.join('\n') });
    assert.equal(d.added, 2);
    assert.equal(d.removed, 2);
    assert.equal(d.diff.split('\n').filter((l) => l === '…').length, 1);
    assert.ok(d.diff.includes('-11|line 10\n+11|changed 10'));
    assert.ok(d.diff.includes('-901|line 900\n+901|changed 900'));
  });
});

describe('files outside the project', () => {
  test('the project folder and what is under it are inside; parents and other drives are not', () => {
    assert.equal(T.inProject('src/a.js'), true);
    assert.equal(T.inProject(path.join(ws, 'deep', 'b.txt')), true);
    assert.equal(T.inProject(ws), true);
    assert.equal(T.inProject('../secret.txt'), false);
    assert.equal(T.inProject(`${ws}-other/x.txt`), false);
    assert.equal(T.inProject(path.join(os.homedir(), '.ssh', 'id_rsa')), false);
  });

  const ask = (approvals, name, p, allow = []) =>
    AgentProc.prototype._mustAsk.call({ config: { data: { approvals, trusted: [] } }, allowAlways: new Set(allow), tools: T, _outside: AgentProc.prototype._outside, _needsApproval: (n) => ['write', 'edit', 'bash'].includes(n) }, { name }, { path: p });

  test('a read outside the project asks, even though reads inside never do', () => {
    assert.equal(ask('ask', 'read', 'src/a.js'), false);
    assert.equal(ask('ask', 'read', '../secret.txt'), true);
    assert.equal(ask('edits', 'grep', path.join(os.homedir(), '.ssh')), true);
  });
  test('Allow edits still asks before writing outside the project', () => {
    assert.equal(ask('edits', 'write', 'src/new.js'), false);
    assert.equal(ask('edits', 'write', '../elsewhere.js'), true);
  });
  test('Allow everything and an approval for the session do not ask again', () => {
    assert.equal(ask('auto', 'read', '../secret.txt'), false);
    assert.equal(ask('ask', 'read', '../secret.txt', ['read:outside']), false);
  });
});

describe('edit and line endings', () => {
  test('one stray CRLF line does not make new lines in an LF file CRLF', async () => {
    const f = path.join(ws, 'mixed.txt');
    fs.writeFileSync(f, 'a\nb\r\nc\nd\n');
    const r = await T.run('edit', { path: f, old_string: 'c\n', new_string: 'c1\nc2\n' }, {});
    assert.equal(r.isError, undefined, r.text);
    assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\r\nc1\nc2\nd\n');
  });
});

describe('a helper agent that runs out of context', () => {
  test('clears old tool output and answers instead of failing', async () => {
    const seen = [];
    let calls = 0;
    const ctx = {
      idPrefix: 'sub',
      system: 'sys',
      toolDefs: [],
      async *stream({ messages }) {
        seen.push(messages);
        if (calls++ === 0) throw new Error('prompt is too long: 250000 tokens > 200000 maximum');
        yield { type: 'start' };
        yield { type: 'text', index: 0, text: 'Found it in a.js.' };
      },
      runTool: async () => ({ text: '' }),
    };
    const r = await runTasks({ tasks: [{ task: 'find it' }] }, ctx);
    assert.equal(r.isError, false);
    assert.match(r.text, /Found it in a\.js\./);
    assert.match(seen[1].at(-1).content[0].text, /context is full/);
    assert.equal('final' in seen[1].at(-1), false); // the engine's own flag is not sent to the provider
  });
});
