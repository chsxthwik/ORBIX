// A tiny Agent Client Protocol agent for the tests: it answers initialize, session/new, session/load and
// session/prompt. A prompt containing "cmd" asks permission to run a command first, then reports the step.
import readline from 'node:readline';

// `node --test` runs every file under test/, this one too: only serve when a test starts it.
if (!process.argv.includes('--serve')) process.exit(0);

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let seq = 1000;
let model = 'fake/small';
let activePrompt;
const modelState = () => ({ configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ group: 'Fake provider', options: [{ value: 'fake/small', name: 'Small' }, { value: 'fake/large', name: 'Large' }] }] }] });
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
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: process.argv.includes('--wrong-version') ? 99 : 1, agentInfo: { name: 'fixture', version: '0.1.0' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'fake-1', ...modelState() } });
  if (m.method === 'session/set_config_option') {
    model = p.value;
    return send({ id: m.id, result: modelState() });
  }
  if (m.method === 'session/load') {
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
    update(p.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review' }] });
    return send({ id: m.id, result: modelState() });
  }
  if (m.method === 'session/cancel') {
    if (activePrompt) send({ id: activePrompt, result: { stopReason: 'cancelled' } });
    activePrompt = null;
    return;
  }
  if (m.method === 'session/prompt') {
    const text = p.prompt.map((c) => c.text || '').join(' ');
    const sid = p.sessionId;
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } });
    update('another-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'UNRELATED' } });
    if (text === 'wait') {
      activePrompt = m.id;
      return;
    }
    if (/cmd/.test(text)) {
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'echo hi', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } });
      const options = [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }];
      if (!text.includes('persistent-only')) options.push({ optionId: 'yes', name: 'Allow once', kind: 'allow_once' });
      const r = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1', title: 'echo hi', kind: 'execute', rawInput: { command: 'echo hi' } }, options });
      const allowed = ['yes', 'always'].includes(r?.outcome?.optionId);
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'hi' : 'denied' } }] });
    }
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'from fake' } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
});
