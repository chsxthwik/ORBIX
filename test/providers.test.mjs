// Model providers: readable errors, chat-only model lists, time limits and a model list that follows provider changes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-providers-test-'));
process.env.ORBIX_DATA = tmp;
const { httpError } = await import('../src/engine/anthropic.mjs');
const { modelRows } = await import('../src/engine/openai.mjs');
const { clientFor } = await import('../src/engine/providers.mjs');
const { EngineConfig } = await import('../src/engine/store.mjs');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })); // after any late background write

const res = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('provider errors', () => {
  test('a wrong key answered with 400 (Gemini, xAI) reads as a refused key', async () => {
    const g = await httpError(res(400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]));
    assert.equal(g.status, 401);
    assert.match(g.message, /refused the API key or sign-in \(401\): API key not valid/);
    const x = await httpError(res(400, { error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }));
    assert.equal(x.status, 401);
  });
  test('a 400 about something else stays a 400', async () => {
    const e = await httpError(res(400, { error: { message: 'max_tokens is too large' } }));
    assert.equal(e.status, 400);
    assert.match(e.message, /Provider error 400: max_tokens is too large/);
  });
  test('FastAPI-style details are read as text, not shown as JSON', async () => {
    assert.match((await httpError(res(401, { detail: 'Invalid API Key' }))).message, /\(401\): Invalid API Key$/);
    assert.match((await httpError(res(422, { detail: [{ msg: 'field required' }, { msg: 'bad model' }] }))).message, /field required; bad model$/);
  });
});

describe('model lists', () => {
  test('only chat models are offered', () => {
    const ids = ['gemini-3.5-flash', 'gemini-embedding-001', 'lyria-3-pro-preview', 'gemini-3.1-flash-live-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-image', 'deep-research-preview-04-2026', 'gemini-2.5-computer-use-preview-10-2025', 'gemini-3.5-live-translate-preview', 'gemma-4-31b-it', 'gpt-6-luna', 'claude-opus-5-5', 'olive-7b'];
    assert.deepEqual(modelRows({ data: ids.map((id) => ({ id })) }).map((m) => m.id), ['claude-opus-5-5', 'gemini-3.5-flash', 'gemma-4-31b-it', 'gpt-6-luna', 'olive-7b']);
  });
  test('a custom server with no /models says where it looked', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => res(404, 'Not Found'));
    await assert.rejects(() => clientFor('openai').listModels({ apiKey: '', baseUrl: 'http://localhost:8000/', providerId: 'custom' }), /no model list at http:\/\/localhost:8000\/models\. Check the server address: it usually ends in \/v1/);
  });
  test('a local app that is not running is named', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    await assert.rejects(() => clientFor('openai').listModels({ apiKey: '', baseUrl: 'http://localhost:11434/v1', providerId: 'ollama' }), /Ollama is not answering at http:\/\/localhost:11434\/v1\. Start Ollama and try again\./);
  });
  test('a provider that does not answer in time is reported, not waited on forever', async (t) => {
    t.mock.method(globalThis, 'fetch', (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    // A ref'd timer: Node 22 does not keep the process alive for AbortSignal.timeout() while fetch hangs.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(new DOMException('The operation timed out.', 'TimeoutError')), 30);
    const signal = ctl.signal;
    await assert.rejects(() => clientFor('openai').listModels({ apiKey: 'k', baseUrl: 'https://api.groq.com/openai/v1', providerId: 'groq', signal }), /Groq did not answer within 20 seconds/);
  });
});

describe('the model list follows provider changes', () => {
  let calls = 0;
  before(() => {
    globalThis.__realFetch = globalThis.fetch;
    globalThis.fetch = async () => (calls++, res(200, { data: [{ id: `model-${calls}` }] }));
  });
  after(() => (globalThis.fetch = globalThis.__realFetch));
  test('a list is reused, and asked for again once a provider changes', async () => {
    const cfg = new EngineConfig();
    await cfg.setProvider('groq', { key: 'gsk_test' });
    const a = await cfg.listModels('groq');
    const b = await cfg.listModels('groq');
    assert.equal(calls, 1);
    assert.deepEqual(a, b);
    await cfg.setProvider('groq', { key: 'gsk_other' }); // a new key
    const c = await cfg.listModels('groq');
    assert.equal(calls, 2);
    assert.notDeepEqual(a, c);
    assert.equal((await cfg.listModels('groq', { fresh: true }))[0].id, 'model-3');
  });
});

describe('what the ChatGPT plan reports about its models wins over the catalog', () => {
  test('context window, effort levels, default effort and images come from the plan', async () => {
    const { planFacts } = await import('../src/engine/chatgpt.mjs');
    const { setLiveInfo, modelInfo } = await import('../src/engine/catalog.mjs');
    const { thinkingLevels, defaultThinking, canStopThinking } = await import('../src/engine/providers.mjs');
    const raw = { slug: 'gpt-test-sol', context_window: 272000, max_context_window: 872000, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }], input_modalities: ['text', 'image'] };
    setLiveInfo('chatgpt', raw.slug, planFacts(raw));
    const info = modelInfo('chatgpt', raw.slug);
    assert.equal(info.contextWindow, 272000); // the working window, not the larger maximum
    assert.equal(info.cost.input, null); // plan usage has no per-token price
    assert.equal(info.vision, true);
    assert.equal(canStopThinking('chatgpt', raw.slug), false);
    assert.deepEqual(thinkingLevels('chatgpt', raw.slug), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    assert.equal(defaultThinking('chatgpt', raw.slug), 'low');
  });
  test('a model without a reported default starts at medium', async () => {
    const { setLiveInfo } = await import('../src/engine/catalog.mjs');
    const { defaultThinking } = await import('../src/engine/providers.mjs');
    setLiveInfo('chatgpt', 'gpt-test-luna', { efforts: ['low', 'medium', 'high'] });
    assert.equal(defaultThinking('chatgpt', 'gpt-test-luna'), 'medium');
  });
});

describe('effort levels the API accepts', () => {
  test('the accepted levels are read from a refusal for this model, never from the generic list', async () => {
    const { supportedEfforts } = await import('../src/engine/chatgpt.mjs');
    const own = "Unsupported value: 'none' is not supported with the 'gpt-6-astra' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.";
    assert.deepEqual(supportedEfforts(own, 'none'), ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(supportedEfforts(own, 'low'), null); // the refusal was about another value
    assert.equal(supportedEfforts("Invalid value: 'ultra'. Supported values are: 'none', 'minimal', 'low'.", 'ultra'), null);
  });
  test('off is sent as the effort none only to a model that takes it', async () => {
    const { buildBody } = await import('../src/engine/chatgpt.mjs');
    const base = { model: 'm', system: '', messages: [], tools: [], thinking: 'off' };
    assert.deepEqual(buildBody({ ...base, style: { kind: 'effort', efforts: ['none', 'low'] } }).reasoning, { effort: 'none' });
    assert.equal(buildBody({ ...base, style: { kind: 'effort', efforts: ['low', 'high'] } }).reasoning, undefined);
  });
  test('a refused level is learned and the turn runs again at the nearest accepted one', async (t) => {
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body.reasoning?.effort);
      if (body.reasoning?.effort === 'xhigh') return res(400, { error: { message: "Unsupported value: 'xhigh' is not supported with the 'gpt-test-x' model. Supported values are: 'low', 'medium', and 'high'." } });
      const sse = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const { thinkingLevels } = await import('../src/engine/providers.mjs');
    const jwt = (o) => ['e30', Buffer.from(JSON.stringify(o)).toString('base64url'), 'x'].join('.');
    let text = '';
    for await (const ev of clientFor('chatgpt').stream({ apiKey: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } }), baseUrl: 'https://chatgpt.com/backend-api/codex', providerId: 'chatgpt', model: 'gpt-test-x', thinking: 'xhigh', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) if (ev.type === 'text') text += ev.text;
    assert.deepEqual(sent, ['xhigh', 'high']);
    assert.equal(text, 'OK');
    assert.deepEqual(thinkingLevels('chatgpt', 'gpt-test-x'), ['low', 'medium', 'high']);
  });
});

test('the window learns that a model always thinks (the server keeps canOff)', async () => {
  const { slimModel } = await import('../src/server.mjs');
  const m = slimModel({ id: 'gpt-x', provider: 'chatgpt', name: 'X', reasoning: true, thinking: { efforts: ['low', 'max'], mode: 'effort', canOff: false, default: 'low' } });
  assert.deepEqual(m.thinking, { efforts: ['low', 'max'], mode: 'effort', canOff: false, default: 'low' });
  assert.equal(slimModel({ id: 'y', thinking: { efforts: ['low'], mode: 'effort' } }).thinking.canOff, true);
});
