// The ChatGPT plan client: request shape (as current Codex sends it), stream events, tool calls, reasoning that is
// sent back, and the plan's own errors. The server is mocked; nothing leaves this machine.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as chatgpt from '../src/engine/chatgpt.mjs';
import { clientFor } from '../src/engine/providers.mjs';
import { TurnAssembler } from '../src/engine/assemble.mjs';
import { AgentProc } from '../src/engine/proc.mjs';

const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const TOKEN = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9', chatgpt_plan_type: 'pro' } });
const BASE = 'https://chatgpt.com/backend-api/codex';

const realFetch = globalThis.fetch;
let last = null;
let reply = () => new Response('', { status: 500 });
globalThis.fetch = async (url, init = {}) => {
  last = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
  return reply(last);
};
after(() => (globalThis.fetch = realFetch));
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const collect = async (it) => {
  const out = [];
  for await (const ev of it) out.push(ev);
  return out;
};

describe('ChatGPT plan requests', () => {
  test('headers and body follow current Codex: developer instructions, no API-only fields, encrypted reasoning', async () => {
    reply = () => sse([{ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } }]);
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Fix it' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', thinkingSignature: 'cx:' + JSON.stringify([{ type: 'reasoning', summary: [], encrypted_content: 'ENC' }]) }, { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.js' } }] },
      { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'file' }] },
    ];
    await collect(clientFor('chatgpt').stream({ apiKey: TOKEN, baseUrl: BASE, providerId: 'chatgpt', model: 'gpt-6-sol', system: 'Be exact.', messages, tools: [{ name: 'read', description: 'Read', input_schema: { type: 'object' } }], thinking: 'high' }));
    assert.equal(last.url, `${BASE}/responses`);
    const h = last.init.headers;
    assert.equal(h.authorization, `Bearer ${TOKEN}`);
    assert.equal(h['chatgpt-account-id'], 'acct-9');
    assert.equal(h.originator, 'codex_cli_rs');
    assert.equal(h.accept, 'text/event-stream');
    const b = last.body;
    assert.equal(b.instructions, undefined);
    assert.deepEqual(b.input[0], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Be exact.' }] });
    assert.deepEqual(b.input.slice(1), [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] },
      { type: 'reasoning', summary: [], encrypted_content: 'ENC' },
      { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.js"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file' },
    ]);
    assert.deepEqual(b.tools, [{ type: 'function', name: 'read', description: 'Read', parameters: { type: 'object' }, strict: false }]);
    assert.equal(b.store, false);
    assert.equal(b.stream, true);
    assert.deepEqual(b.include, ['reasoning.encrypted_content']);
    assert.deepEqual(b.reasoning, { effort: 'high', summary: 'auto' });
    for (const k of ['max_output_tokens', 'max_tokens', 'max_completion_tokens', 'temperature']) assert.equal(b[k], undefined, k);
  });

  test('a stream with reasoning, text and a tool call assembles into one assistant message', async () => {
    reply = () => sse([
      { type: 'response.created' },
      { type: 'response.reasoning_summary_text.delta', delta: 'Looking at a.js' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at a.js' }], encrypted_content: 'E2' } },
      { type: 'response.output_text.delta', output_index: 1, delta: 'Reading ' },
      { type: 'response.output_text.delta', output_index: 1, delta: 'it.' },
      // no output_item.added and no argument deltas: Codex reads the call from output_item.done
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: 'call_7', name: 'read', arguments: '{"path":"a.js"}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 9 } } },
    ]);
    const evs = await collect(chatgpt.streamTurn({ apiKey: TOKEN, baseUrl: BASE, model: 'gpt-6-sol', messages: [{ role: 'user', content: 'x' }] }));
    const msg = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' };
    const asm = new TurnAssembler(msg);
    for (const ev of evs) asm.push(ev);
    asm.finish();
    const think = msg.content.find((c) => c.type === 'thinking');
    assert.equal(think.thinking, 'Looking at a.js');
    assert.deepEqual(JSON.parse(think.thinkingSignature.slice(3)), [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at a.js' }], encrypted_content: 'E2' }]);
    assert.equal(msg.content.find((c) => c.type === 'text').text, 'Reading it.');
    const call = msg.content.find((c) => c.type === 'toolCall');
    assert.deepEqual([call.id, call.name, call.arguments], ['call_7', 'read', { path: 'a.js' }]);
    assert.deepEqual(evs.find((e) => e.type === 'usage'), { type: 'usage', input: 60, output: 9, cacheRead: 40, cacheWrite: 0 });
    assert.equal(evs.at(-1).reason, 'tool_use');
  });

  test('streamed argument deltas are not doubled by the final item', async () => {
    reply = () => sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'grep' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"x"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'grep', arguments: '{"q":"x"}' } },
      { type: 'response.completed', response: {} },
    ]);
    const evs = await collect(chatgpt.streamTurn({ apiKey: TOKEN, baseUrl: BASE, model: 'm', messages: [] }));
    assert.equal(evs.filter((e) => e.type === 'tool_json').map((e) => e.json).join(''), '{"q":"x"}');
    assert.equal(evs.filter((e) => e.type === 'tool_start').length, 1);
  });
});

describe('ChatGPT plan models and errors', () => {
  test('the model list comes from /models with the client version; hidden models are left out', async () => {
    reply = () => new Response(JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list' }, { slug: 'secret', visibility: 'hide' }] }), { status: 200 });
    const list = await clientFor('chatgpt').listModels({ apiKey: TOKEN, baseUrl: BASE, providerId: 'chatgpt' });
    assert.deepEqual(list, [{ id: 'gpt-6-sol', name: 'GPT-6 Sol' }]);
    assert.equal(last.url, `${BASE}/models?client_version=${chatgpt.CLIENT_VERSION}`);
  });

  test('the usage limit says when it resets and is not retried', async () => {
    reply = () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 1800 } }), { status: 429 });
    await assert.rejects(() => collect(chatgpt.streamTurn({ apiKey: TOKEN, baseUrl: BASE, model: 'm', messages: [] })), (e) => /usage limit \(plus\)\. It resets in 30 min/.test(e.message) && e.retryable === false);
  });

  test('an expired or foreign token asks for a new sign-in', async () => {
    reply = () => new Response('{}', { status: 401 });
    await assert.rejects(() => collect(chatgpt.streamTurn({ apiKey: TOKEN, baseUrl: BASE, model: 'm', messages: [] })), /sign-in has expired/);
    await assert.rejects(() => collect(chatgpt.streamTurn({ apiKey: 'sk-plain-key', baseUrl: BASE, model: 'm', messages: [] })), /not valid any more/);
  });

  test('a failed response ends the turn with its message', async () => {
    reply = () => sse([{ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'Too long' } } }]);
    await assert.rejects(() => collect(chatgpt.streamTurn({ apiKey: TOKEN, baseUrl: BASE, model: 'm', messages: [] })), (e) => e.message === 'Too long' && e.retryable === false);
  });
});

describe('sign-in recovery', () => {
  const rejecting = (keys) => ({ stream: async function* (a) { keys.push(a.apiKey); if (a.apiKey === 'old') throw Object.assign(new Error('rejected'), { status: 403 }); yield { type: 'start' }; yield { type: 'text', index: 0, text: 'ok' }; } });
  const run = async (config, client) => { const out = []; for await (const ev of AgentProc.prototype._signedIn.call({ config }, client, (a) => ({ apiKey: 'old', ...a }), 'xai')({})) out.push(ev); return out; };
  test('a rejected sign-in token is renewed once and the request repeated', async () => {
    const keys = [];
    const config = { isSignIn: () => true, renewSignIn: async () => 'new', provider: () => ({ name: 'xAI' }) };
    const out = await run(config, rejecting(keys));
    assert.deepEqual(keys, ['old', 'new']);
    assert.equal(out.at(-1).text, 'ok');
  });
  test('a sign-in that cannot be renewed asks for a new sign-in', async () => {
    const config = { isSignIn: () => true, renewSignIn: async () => null, provider: () => ({ name: 'xAI' }) };
    await assert.rejects(() => run(config, rejecting([])), /xAI no longer accepts this sign-in\. Sign in with xAI again/);
  });
  test('a pasted API key that is rejected is not retried', async () => {
    const keys = [];
    const config = { isSignIn: () => false, renewSignIn: async () => 'new', provider: () => ({ name: 'xAI' }) };
    await assert.rejects(() => run(config, rejecting(keys)), /rejected/);
    assert.deepEqual(keys, ['old']);
  });
});
