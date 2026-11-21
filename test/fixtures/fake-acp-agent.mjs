// A tiny Agent Client Protocol agent for the tests: it answers initialize, session/new, session/load and
// session/prompt. A prompt containing "cmd" asks permission to run a command first, then reports the step.
import readline from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let seq = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  waiting.set(id, resolve);
  send({ id, method, params });
});

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) return waiting.get(m.id)?.(m.result);
  const p = m.params || {};
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'fake-1', models: { availableModels: [{ modelId: 'fake/small', name: 'Small' }], currentModelId: 'fake/small' } } });
  if (m.method === 'session/load') {
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/cancel') return;
  if (m.method === 'session/prompt') {
    const text = p.prompt.map((c) => c.text || '').join(' ');
    const sid = p.sessionId;
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } });
    if (/cmd/.test(text)) {
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo hi', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
      const r = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1', title: 'echo hi', kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
      const allowed = r?.outcome?.optionId === 'yes';
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'hi' : 'denied' } }] });
    }
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from fake' } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
});
