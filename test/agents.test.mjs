// Other agent CLIs as conversation engines (src/harness): tool names mapped to ORBIX's, custom ACP agents, and a full
// conversation with a fake ACP agent: streaming, a permission routed to an ORBIX approval, saving, and resuming.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-agents-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { fromClaude, fromCodex, fromAcp, resultText } = await import('../src/harness/tools.mjs');
const { customAgents, cleanCustomAgent, isAgentId, AgentRegistry } = await import('../src/harness/registry.mjs');
const { HarnessProc } = await import('../src/harness/proc.mjs');
const { Backend } = await import('../src/backend.mjs');
const { loadSession } = await import('../src/engine/store.mjs');

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

describe('tool names', () => {
  test('Claude Code tools read as ORBIX steps', () => {
    assert.deepEqual(fromClaude('Bash', { command: 'npm test', description: 'run the tests' }), { name: 'bash', arguments: { command: 'npm test', description: 'run the tests', tool: 'Bash' } });
    assert.equal(fromClaude('Read', { file_path: 'a.js' }).arguments.path, 'a.js');
    assert.equal(fromClaude('MultiEdit', { file_path: 'b.js' }).name, 'edit');
    assert.equal(fromClaude('WebFetch', { url: 'https://x' }).name, 'web_fetch');
    assert.equal(fromClaude('SomethingNew', { a: 1 }).name, 'SomethingNew');
  });
  test('Codex items and ACP tool calls', () => {
    assert.deepEqual(fromCodex({ type: 'commandExecution', command: 'ls -la' }).arguments.command, 'ls -la');
    assert.equal(fromCodex({ type: 'fileChange', changes: [{ path: 'x.js' }] }).name, 'edit');
    assert.equal(fromCodex({ type: 'fileChange', changes: [{ path: 'x.js' }, { path: 'y.js' }] }).name, 'patch');
    assert.equal(fromCodex({ type: 'agentMessage', text: 'hi' }), null);
    assert.equal(fromAcp({ kind: 'execute', title: 'npm test', rawInput: { command: 'npm test' } }).arguments.command, 'npm test');
    assert.equal(fromAcp({ kind: 'edit', locations: [{ path: 'z.js' }] }).arguments.path, 'z.js');
    assert.equal(resultText([{ type: 'content', content: { type: 'text', text: 'out' } }]), 'out');
  });
});

describe('custom agents', () => {
  test('ids, commands and checks', () => {
    assert.ok(isAgentId('agent-claude'));
    assert.ok(!isAgentId('anthropic'));
    const [a] = customAgents([{ name: 'My Agent', command: 'my-agent --acp' }]);
    assert.equal(a.id, 'agent-x-my-agent');
    assert.deepEqual([a.cmd, ...a.args], ['my-agent', '--acp']);
    assert.throws(() => cleanCustomAgent({ name: '', command: 'x' }), /name/);
    assert.throws(() => cleanCustomAgent({ name: 'X', command: ' ' }), /command/);
  });
});

describe('a conversation on an ACP agent', () => {
  const backend = new Backend({ kind: 'native' });
  const config = { data: { approvals: 'ask', agents: [{ name: 'Fake', command: `${process.execPath} ${FAKE}` }] } };
  const registry = new AgentRegistry({ backend, config });
  // The test agent's command has an absolute path to node, so detection does not depend on PATH.
  registry.detect = async () => ({ 'agent-x-fake': { path: process.execPath, version: 'test' } });
  const agent = { ...registry.get('agent-x-fake'), args: [FAKE] };
  const ws = path.join(TMP, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  let file;

  test('streams, asks through ORBIX, saves', async () => {
    const p = new HarnessProc({ id: 'p1', backend, workspace: ws, config, agent, registry });
    const events = [];
    p.on('event', (ev) => {
      events.push(ev);
      if (ev.type === 'extension_ui_request' && ev.method === 'select') p.send({ type: 'extension_ui_response', id: ev.id, value: 'Allow once' });
    });
    await p.start();
    assert.equal(p.nativeId, 'fake-1');
    const r = await p._turn('please run cmd');
    assert.equal(r.status, 'completed');
    assert.equal(r.toolCalls, 1);
    const ask = events.find((e) => e.type === 'extension_ui_request' && e.method === 'select');
    assert.match(ask.title, /Fake: Run this command\?\s+echo hi/);
    const roles = p.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(p.messages[2].content[0].text, 'hi');
    assert.equal(p.messages[3].content.find((c) => c.type === 'text').text, 'Hello from fake');
    assert.ok(p.messages[1].content.some((c) => c.type === 'thinking'));
    assert.ok(events.some((e) => e.type === 'agent_end'));
    file = p.session.file;
    await p.stop(500);
    const saved = loadSession(file);
    assert.equal(saved.header.engine, 'agent-x-fake');
    assert.equal(saved.native, 'fake-1');
    assert.equal(saved.messages.length, 4);
  });

  test('a denied step is reported to the agent', async () => {
    const p = new HarnessProc({ id: 'p2', backend, workspace: ws, config, agent, registry, noSession: true });
    p.on('event', (ev) => ev.type === 'extension_ui_request' && ev.method === 'select' && p.send({ type: 'extension_ui_response', id: ev.id, value: 'Deny' }));
    await p.start();
    await p._turn('cmd again');
    const res = p.messages.find((m) => m.role === 'toolResult');
    assert.equal(res.isError, true);
    await p.stop(500);
  });

  test('Full access allows without asking; a destructive command still asks', async () => {
    const turbo = { data: { ...config.data, approvals: 'auto' } };
    const p = new HarnessProc({ id: 'p3', backend, workspace: ws, config: turbo, agent, registry, noSession: true });
    assert.equal(await p._approve({ name: 'bash', arguments: { command: 'npm test' } }), 'allow');
    let asked = '';
    p.on('event', (ev) => ev.type === 'extension_ui_request' && ev.method === 'select' && ((asked = ev.title), p.send({ type: 'extension_ui_response', id: ev.id, value: 'Deny' })));
    assert.equal(await p._approve({ name: 'bash', arguments: { command: 'rm -rf build' } }), 'deny');
    assert.match(asked, /Careful/);
    // Command Guard: a command that wrecks the computer is denied without a question.
    asked = '';
    assert.equal(await p._approve({ name: 'bash', arguments: { command: 'rm -rf /' } }), 'deny');
    assert.equal(asked, '');
  });

  test('reopening resumes the agent session without showing its replay twice', async () => {
    const p = new HarnessProc({ id: 'p4', backend, workspace: ws, resume: file, config, agent, registry });
    const texts = [];
    p.on('event', (ev) => ev.type === 'message_end' && texts.push(JSON.stringify(ev.message.content)));
    await p.start();
    assert.equal(p.messages.length, 4);
    assert.equal(p.nativeId, 'fake-1');
    assert.ok(!texts.some((t) => t.includes('REPLAYED')));
    const r = await p._turn('hello');
    assert.equal(r.status, 'completed');
    assert.equal(p.messages.length, 6);
    await p.stop(500);
  });
});

describe('ORBIX Cloud server', () => {
  test('a self-hosted server takes a bearer token; the app’s own server does not', async () => {
    const { AppServer } = await import('../src/server.mjs');
    const { Store } = await import('../src/store.mjs');
    const token = 'c'.repeat(48);
    const get = async (port, headers) => (await fetch(`http://127.0.0.1:${port}/api/procs`, { headers })).status;
    const local = new AppServer({ store: new Store(), token });
    const remote = new AppServer({ store: new Store(), token });
    const lp = await local.listen(0);
    const rp = await remote.listen(0, { remote: true });
    try {
      assert.equal(await get(lp, { authorization: `Bearer ${token}` }), 401);
      assert.equal(await get(rp, { authorization: `Bearer ${token}` }), 200);
      assert.equal(await get(rp, { 'x-orbix-token': token }), 200);
      assert.equal(await get(rp, { authorization: `Bearer ${'d'.repeat(48)}` }), 401);
    } finally {
      local.server.close();
      remote.server.close();
    }
  });
  test('machine addresses: https across the internet, http only on your own network', async () => {
    const { cleanUrl } = await import('../src/cloud.mjs');
    assert.equal(cleanUrl('https://orbix.example.com/x?y'), 'https://orbix.example.com');
    assert.equal(cleanUrl('http://192.168.1.20:47821'), 'http://192.168.1.20:47821');
    assert.equal(cleanUrl('http://my-vps:47821'), 'http://my-vps:47821');
    assert.equal(cleanUrl('http://box.tail1234.ts.net:47821'), 'http://box.tail1234.ts.net:47821');
    assert.throws(() => cleanUrl('http://orbix.example.com'), /https/);
    assert.throws(() => cleanUrl('ftp://x'), /https/);
  });
});
