// OpenAI-compatible chat client (streaming + tool calls). Works with OpenAI, Gemini, xAI, Groq, Mistral, DeepSeek,
// OpenRouter, Together, Fireworks, Cerebras, Kimi, GLM, Qwen, Ollama, LM Studio and any server with the same API.
// Emits the same normalised events as anthropic.mjs.
import crypto from 'node:crypto';
import { parseSSE, httpError, post, streamError, imageBlock } from './anthropic.mjs';
import { VERSION } from '../util.mjs';

const join = (base, p) => base.replace(/\/+$/, '') + p;
const isOpencode = (id) => id === 'opencode' || id === 'opencode-go';
// The OpenCode organization a sign-in chose, per provider (set by EngineConfig; a pasted key has none).
const ORGS = new Map();
export function setProviderOrg(providerId, orgId) {
  if (orgId) ORGS.set(providerId, String(orgId));
  else ORGS.delete(providerId);
}
const headers = (apiKey, providerId, { orgId = ORGS.get(providerId), session } = {}) => ({
  'content-type': 'application/json',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  ...(providerId === 'openrouter' ? { 'x-title': 'ORBIX' } : {}), // OpenRouter app name (optional)
  // OpenCode asks other clients to name themselves and keep one session id per conversation (Go plan rules), and
  // a Console sign-in sends the organization it chose.
  ...(isOpencode(providerId) ? { 'user-agent': 'orbix/' + VERSION, ...(session ? { 'x-opencode-session': session } : {}), ...(orgId ? { 'x-org-id': orgId } : {}) } : {}),
});
// A model OpenCode serves for free answers 403 to every client but its own, so it is not offered.
const isFreeOpencode = (m) => m && typeof m === 'object' && (/(^|-)free$/.test(String(m.id)) || (m.cost?.text?.input?.price === 0 && m.cost?.text?.output?.price === 0));

// Not chat models: hidden from the model picker when the provider lists everything together.
const NOT_CHAT = /(^|[-_/])(embed|embedding|whisper|tts|dall-e|moderation|rerank|transcribe|audio|realtime|speech|sora|veo|imagen|image-gen|guard)([-_./:]|$)|text-embedding|gpt-image|-image(-|$)/i;

/** Rows from any of the /models shapes: {data:[...]}, {models:[...]}, or a bare array (Together). */
export function modelRows(j) {
  const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const out = [];
  for (const m of rows) {
    if (typeof m === 'string') {
      out.push({ id: m, name: m });
      continue;
    }
    let id = m?.id || m?.name || m?.model;
    if (!id || typeof id !== 'string') continue;
    id = id.replace(/^models\//, ''); // Gemini
    if (m.type && !['chat', 'language', 'model', 'llm', 'code'].includes(String(m.type).toLowerCase())) continue; // Together / LM Studio
    if (m.capabilities && m.capabilities.completion_chat === false) continue; // Mistral
    out.push({ id, name: m.display_name || m.displayName || id });
  }
  const chat = out.filter((m) => !NOT_CHAT.test(m.id));
  const list = chat.length ? chat : out;
  const seen = new Set();
  return list.filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.id.localeCompare(b.id));
}

export async function listModels({ apiKey, baseUrl, signal, providerId, orgId = ORGS.get(providerId) }) {
  if (providerId === 'openrouter' && apiKey) {
    // OpenRouter's model list is public, so check the key itself first.
    const k = await post(join(baseUrl, '/key'), { headers: headers(apiKey, providerId), signal }, baseUrl);
    if (!k.ok) throw await httpError(k);
  }
  if (isOpencode(providerId) && apiKey) {
    // OpenCode's model list is public, so check the sign-in or key itself with a request that costs nothing.
    const k = await post(join(baseUrl, '/chat/completions'), { method: 'POST', headers: headers(apiKey, providerId, { orgId }), body: '{}', signal }, baseUrl);
    if (k.status === 401 || k.status === 403) throw await httpError(k);
  }
  const r = await post(join(baseUrl, '/models'), { headers: headers(apiKey, providerId, { orgId }), signal }, baseUrl);
  if (!r.ok) throw await httpError(r);
  const j = await r.json();
  if (isOpencode(providerId) && Array.isArray(j?.data)) j.data = j.data.filter((m) => !isFreeOpencode(m));
  return modelRows(j);
}

// Signatures this client stores on content items, tagged so the Anthropic client never sends them:
//   'oc:' + JSON reasoning_details (OpenRouter) on a thinking item
//   'gx:' + JSON extra_content (Gemini thought signature) on a toolCall item
const parseTag = (sig, tag) => {
  if (typeof sig !== 'string' || !sig.startsWith(tag)) return null;
  try {
    return JSON.parse(sig.slice(tag.length));
  } catch {
    return null;
  }
};

/** An OpenAI image_url part (data URL), or a text part when the image cannot be sent. */
function imagePart(c) {
  const b = imageBlock(c); // same type and size rules as for Claude
  return b.type === 'image' ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : b;
}

/**
 * Internal conversation -> OpenAI chat messages.
 * `interleaved`: 'reasoning_content' sends earlier thinking back (DeepSeek, Kimi, GLM require it with tools).
 * Tool messages can only hold text, so images a tool returned follow the tool messages as one user message.
 */
export function toOpenAIMessages(messages, { interleaved = null } = {}) {
  const out = [];
  let toolImages = [];
  const flushImages = () => {
    if (!toolImages.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...toolImages] });
    toolImages = [];
  };
  for (const m of messages) {
    if (m.role !== 'toolResult') flushImages();
    if (m.role === 'user') {
      const parts = [];
      for (const c of Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]) {
        if (c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
        else if (c.type === 'image' && c.data) parts.push(imagePart(c));
      }
      if (!parts.length) continue;
      out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    } else if (m.role === 'assistant') {
      const content = m.content || [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      const calls = content
        .filter((c) => c.type === 'toolCall')
        .map((c) => {
          const extra = parseTag(c.thinkingSignature, 'gx:');
          return { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) }, ...(extra ? { extra_content: extra } : {}) };
        });
      const thinking = content.filter((c) => c.type === 'thinking');
      const details = thinking.flatMap((c) => parseTag(c.thinkingSignature, 'oc:') || []);
      if (!text && !calls.length && !details.length) continue;
      const msg = { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) };
      if (interleaved === 'reasoning_content') msg.reasoning_content = thinking.map((c) => c.thinking || '').join('');
      if (details.length) msg.reasoning_details = details;
      out.push(msg);
    } else if (m.role === 'toolResult') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '(no output)' });
      for (const c of m.content || []) if (c.type === 'image' && c.data) toolImages.push(imagePart(c));
    }
  }
  flushImages();
  return out;
}

const FINISH = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
// Providers that send earlier thinking back as reasoning_content even when the catalog does not say so.
const REASONING_BACK = new Set(['deepseek', 'moonshot', 'zai']);
// Providers whose chat API accepts reasoning_effort.
const EFFORT_PARAM = new Set(['openai', 'google', 'xai', 'groq', 'mistral', 'together', 'fireworks', 'cerebras', 'deepseek', 'moonshot', 'zai', 'qwen', 'custom', 'ollama', 'lmstudio']);

/** Request body for one turn. */
export function buildBody({ providerId, model, system, messages, tools, maxTokens = 8192, thinking = 'off', style, effort, interleaved }) {
  const back = interleaved || (REASONING_BACK.has(providerId) ? 'reasoning_content' : null);
  const body = { model, stream: true, stream_options: { include_usage: true }, messages: [...(system ? [{ role: 'system', content: system }] : []), ...toOpenAIMessages(messages, { interleaved: back })] };
  // OpenAI reasoning models reject max_tokens; max_completion_tokens works for every current OpenAI model.
  if (providerId === 'openai') body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  // OpenAI routes requests with the same key to the same prompt cache: one key per system prompt (one per session),
  // so every step of the agent loop re-reads the conversation so far from the cache.
  if (providerId === 'openai' && system) body.prompt_cache_key = 'orbix-' + crypto.createHash('sha256').update(system).digest('hex').slice(0, 32);
  const kind = style?.kind || 'none';
  if (providerId === 'openrouter') {
    if (thinking !== 'off') body.reasoning = { effort: thinking };
    else if (kind === 'toggle' || style?.efforts?.includes('none')) body.reasoning = { effort: 'none' };
  } else if (kind === 'toggle' || (kind === 'effort' && style?.toggle)) {
    // On/off switch (DeepSeek, GLM, Kimi use `thinking`; Qwen uses enable_thinking).
    if (providerId === 'qwen') body.enable_thinking = thinking !== 'off';
    else if (['deepseek', 'zai', 'moonshot'].includes(providerId)) body.thinking = { type: thinking !== 'off' ? 'enabled' : 'disabled' };
    if (thinking !== 'off' && kind === 'effort' && effort && EFFORT_PARAM.has(providerId)) body.reasoning_effort = effort;
  } else if (kind === 'effort' && EFFORT_PARAM.has(providerId)) {
    if (thinking !== 'off' && effort) body.reasoning_effort = effort;
    else if (thinking === 'off' && style?.efforts?.includes('none')) body.reasoning_effort = 'none';
  } else if (kind === 'budget' && thinking !== 'off' && EFFORT_PARAM.has(providerId)) {
    body.reasoning_effort = ['minimal', 'low', 'medium', 'high'].includes(thinking) ? thinking : 'high';
  }
  return body;
}

/** Merge streamed OpenRouter reasoning_details chunks into whole blocks (text/summary/data concatenated). */
function mergeDetails(acc, chunk) {
  for (const d of chunk) {
    if (!d || typeof d !== 'object') continue;
    const key = d.index ?? acc.length;
    let cur = acc.find((x) => (x.index ?? -1) === key && x.type === d.type);
    if (!cur) {
      acc.push({ ...d });
      continue;
    }
    for (const f of ['text', 'summary', 'data']) if (typeof d[f] === 'string') cur[f] = (cur[f] || '') + d[f];
    for (const f of ['signature', 'id', 'format']) if (d[f]) cur[f] = d[f];
  }
}

export async function* streamTurn({ apiKey, baseUrl, signal, orgId: org, ...rest }) {
  const orgId = org || ORGS.get(rest.providerId);
  const body = buildBody(rest);
  const session = isOpencode(rest.providerId) && rest.system ? 'orbix-' + crypto.createHash('sha256').update(rest.system).digest('hex').slice(0, 24) : null;
  const r = await post(join(baseUrl, '/chat/completions'), { method: 'POST', headers: headers(apiKey, rest.providerId, { orgId, session }), body: JSON.stringify(body), signal }, baseUrl);
  if (!r.ok) throw await httpError(r);
  yield { type: 'start' };
  // Tool calls by stream key: { idx (block index), id, name, extra (Gemini extra_content), buf (arguments before
  // the name arrived), started }. tool_start waits for the name, which some servers send after the id.
  const calls = new Map();
  const byIndex = new Map(); // the server's tool call index -> key of the call it currently means
  let lastKey = null;
  const keyOf = (tc) => {
    if (Number.isInteger(tc.index)) {
      const k = byIndex.get(tc.index);
      const cur = k != null ? calls.get(k) : null;
      // A server that numbers every call 0 but gives each its own id is sending a new call.
      if (cur && !(tc.id && cur.id && tc.id !== cur.id)) return k;
      const nk = `call${calls.size}`;
      byIndex.set(tc.index, nk);
      return nk;
    }
    // No index (one whole call per chunk): a known id continues that call, a new id starts one, no id continues the last.
    if (tc.id) {
      for (const [k, c] of calls) if (c.id === tc.id) return k;
      return `call${calls.size}`;
    }
    return lastKey ?? `call${calls.size}`;
  };
  const startCall = function* (c) {
    c.started = true;
    yield { type: 'tool_start', index: c.idx, id: c.id || `call_${c.idx}_${Date.now().toString(36)}`, name: c.name || '' };
    if (c.buf) yield { type: 'tool_json', index: c.idx, json: c.buf };
    c.buf = '';
  };
  const details = [];
  let sawThinking = false;
  let finished = false;
  const flushTools = function* () {
    for (const c of calls.values()) {
      if (!c.started) yield* startCall(c);
      if (c.extra) yield { type: 'signature', index: c.idx, signature: 'gx:' + JSON.stringify(c.extra) };
      yield { type: 'block_stop', index: c.idx };
    }
  };
  const flushReasoning = function* () {
    if (!details.length) return;
    if (!sawThinking) yield { type: 'thinking', index: -1, text: '' };
    yield { type: 'signature', index: -1, signature: 'oc:' + JSON.stringify(details) };
    details.length = 0;
  };
  try {
    for await (const { data } of parseSSE(r.body, signal)) {
      if (data.trim() === '[DONE]') break;
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      if (d.error) {
        const e = new Error(d.error.message || 'The provider reported an error mid-stream');
        const code = Number(d.error.code);
        e.status = Number.isFinite(code) ? code : 500;
        e.retryable = e.status === 429 || e.status >= 500;
        throw e;
      }
      if (d.usage) {
        // Normalise to Anthropic meaning: `input` excludes cached tokens (OpenAI's prompt_tokens includes them).
        const cached = d.usage.prompt_cache_hit_tokens ?? d.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const cacheWrite = d.usage.prompt_tokens_details?.cache_write_tokens ?? 0;
        const u = { type: 'usage', input: Math.max(0, (d.usage.prompt_tokens || 0) - cached - cacheWrite), output: d.usage.completion_tokens || 0, cacheRead: cached, cacheWrite };
        if (typeof d.usage.cost === 'number') u.costUsd = d.usage.cost; // OpenRouter reports the real charge
        yield u;
      }
      const ch = d.choices?.[0];
      if (!ch) continue;
      const delta = ch.delta || {};
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
        mergeDetails(details, delta.reasoning_details);
        if (!reasoning) {
          const t = delta.reasoning_details.map((x) => (typeof x.text === 'string' ? x.text : typeof x.summary === 'string' ? x.summary : '')).join('');
          if (t) {
            sawThinking = true;
            yield { type: 'thinking', index: -1, text: t };
          }
        }
      }
      if (reasoning) {
        sawThinking = true;
        yield { type: 'thinking', index: -1, text: reasoning };
      }
      if (delta.content) yield { type: 'text', index: 0, text: delta.content };
      for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!tc || typeof tc !== 'object') continue;
        const key = keyOf(tc);
        lastKey = key;
        let c = calls.get(key);
        if (!c) calls.set(key, (c = { idx: 1000 + calls.size, id: '', name: '', extra: null, buf: '', started: false }));
        if (tc.id && !c.id) c.id = tc.id;
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        if (tc.extra_content) c.extra = tc.extra_content; // Gemini thought signature
        const json = typeof tc.function?.arguments === 'string' ? tc.function.arguments : tc.function?.arguments && typeof tc.function.arguments === 'object' ? JSON.stringify(tc.function.arguments) : '';
        if (!c.started && c.name) yield* startCall(c);
        if (json) {
          if (c.started) yield { type: 'tool_json', index: c.idx, json };
          else c.buf += json;
        }
      }
      if (ch.finish_reason && !finished) {
        finished = true;
        yield* flushReasoning();
        yield* flushTools();
        yield { type: 'stop', reason: FINISH[ch.finish_reason] || 'end_turn' };
      }
    }
  } catch (e) {
    throw streamError(e, signal);
  }
  if (!finished) {
    yield* flushReasoning();
    yield* flushTools();
    yield { type: 'stop', reason: calls.size ? 'tool_use' : 'end_turn' };
  }
}
