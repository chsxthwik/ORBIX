// Anthropic Messages API client (streaming). Dependency-free: uses Node's built-in fetch.
// Turns the provider's server-sent events into small normalised events the engine loop consumes.
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from './files.mjs';

/** Parse a fetch() body stream of server-sent events into {event, data} objects. */
export async function* parseSSE(body, signal) {
  const dec = new TextDecoder();
  let buf = '';
  const reader = body.getReader();
  const block = (raw) => {
    let event = 'message';
    const data = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const ev = block(raw);
        if (ev) yield ev;
      }
    }
    // Some servers end the stream right after the last event, without the blank line.
    const last = block(buf + dec.decode());
    if (last) yield last;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

const VERSION = '2023-06-01';

function authHeaders(apiKey) {
  return { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' };
}

/** Real list of models the key can use (never hard-coded, so it cannot go stale). */
export async function listModels({ apiKey, baseUrl = 'https://api.anthropic.com', signal }) {
  const out = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const r = await post(`${baseUrl.replace(/\/+$/, '')}/v1/models?limit=100${after ? '&after_id=' + encodeURIComponent(after) : ''}`, { headers: authHeaders(apiKey), signal }, baseUrl);
    if (!r.ok) throw await httpError(r);
    const j = await r.json();
    for (const m of j.data || []) out.push({ id: m.id, name: m.display_name || m.id });
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return out;
}

/** Milliseconds the provider asked us to wait (retry-after-ms / retry-after seconds or date), or NaN. */
export function retryAfterMs(headers) {
  const rawMs = headers?.get?.('retry-after-ms');
  const ms = rawMs ? Number(rawMs) : NaN;
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const ra = headers?.get?.('retry-after');
  if (!ra) return NaN;
  const sec = Number(ra);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : NaN;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

/** An Error for a failed HTTP response, tagged with status / retryable / retryAfterMs for the retry wrapper. */
export async function httpError(r, { quotaWords = /insufficient_quota|exceeded your current quota|billing|credit balance/i } = {}) {
  let detail = '';
  try {
    const text = await r.text();
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || JSON.stringify(j).slice(0, 300);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch {}
  const s = r.status;
  let msg;
  if (s === 401 || s === 403) msg = `The API key was rejected (${s})`;
  else if (s === 429) msg = 'Rate limited (429)';
  else if (s === 529) msg = 'The provider is overloaded (529)';
  else msg = `Provider error ${s}`;
  const e = new Error(msg + (detail ? ': ' + detail : ''));
  e.status = s;
  // Out of credit / quota is a 429 too, but waiting will not fix it.
  e.retryable = (RETRY_STATUS.has(s) || s >= 500) && !(s === 429 && quotaWords.test(detail));
  e.retryAfterMs = retryAfterMs(r.headers);
  return e;
}

/** fetch() that turns connection failures into a retryable, readable Error. */
export async function post(url, init, label) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    const err = new Error(`Cannot reach ${label}: ${e.cause?.code || e.cause?.message || e.message}`);
    err.retryable = true;
    throw err;
  }
}

/** Re-throw a mid-stream read failure (socket reset...) as retryable unless the user aborted. */
export function streamError(e, signal) {
  if (signal?.aborted || e?.status) return e;
  const err = new Error(`Connection lost: ${e?.cause?.code || e?.message || e}`);
  err.retryable = true;
  return err;
}

// Thinking token budgets for models that take budget_tokens (Claude 3.7 / 4 / 4.5).
const BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000 };

/** A copy of `messages` whose last cacheable block carries cache_control (thinking blocks cannot). */
export function withCacheBreakpoint(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content) || !last.content.length) return messages;
  const i = last.content.findLastIndex((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
  if (i < 0) return messages;
  const content = last.content.slice();
  content[i] = { ...content[i], cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content }];
}

/** Build the request body for one turn. */
export function buildBody({ model, system, messages, tools, maxTokens = 8192, thinking = 'off', style, effort, maxOutput }) {
  const body = { model, max_tokens: maxTokens, stream: true, messages: withCacheBreakpoint(messages) };
  // Prompt caching (3 of the 4 allowed breakpoints): tools, the system prompt (both stable for a session), and the
  // newest message, so each step of the agent loop re-reads the whole conversation so far from the cache.
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools?.length) body.tools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  if (thinking !== 'off' && style?.kind === 'effort') {
    // Claude 4.6+: adaptive thinking; depth is set by effort. "summarized" so the thinking text is shown.
    body.thinking = { type: 'adaptive', display: 'summarized' };
    if (effort) body.output_config = { effort };
  } else if (thinking !== 'off' && style?.kind === 'budget') {
    let budget = BUDGET[thinking] || BUDGET.medium;
    let max = Math.max(maxTokens, budget + 4096);
    if (maxOutput && max > maxOutput) max = maxOutput;
    budget = Math.max(1024, Math.min(budget, max - 1024));
    if (max <= budget) max = budget + 1024;
    body.max_tokens = max;
    body.thinking = { type: 'enabled', budget_tokens: budget }; // no temperature is ever sent with thinking
  }
  return body;
}

/**
 * Stream one assistant turn.
 * Yields: {type:'start'} {type:'text',index,text} {type:'thinking',index,text} {type:'signature',index,signature[,redacted]}
 *         {type:'tool_start',index,id,name} {type:'tool_json',index,json}
 *         {type:'block_stop',index} {type:'usage',input,output,cacheRead,cacheWrite} {type:'stop',reason}
 */
export async function* streamTurn({ apiKey, baseUrl = 'https://api.anthropic.com', signal, ...rest }) {
  const body = buildBody(rest);
  const r = await post(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body), signal }, baseUrl);
  if (!r.ok) throw await httpError(r);
  yield { type: 'start' };
  const sigs = new Map(); // block index -> {signature, redacted}
  try {
    for await (const { event, data } of parseSSE(r.body, signal)) {
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event) {
        case 'message_start': {
          const u = d.message?.usage || {};
          yield { type: 'usage', input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
          break;
        }
        case 'content_block_start': {
          const b = d.content_block || {};
          if (b.type === 'tool_use') yield { type: 'tool_start', index: d.index, id: b.id, name: b.name };
          else if (b.type === 'text' && b.text) yield { type: 'text', index: d.index, text: b.text };
          else if (b.type === 'thinking') {
            yield { type: 'thinking', index: d.index, text: b.thinking || '' }; // may stay empty when the text is hidden
            if (b.signature) sigs.set(d.index, { signature: b.signature });
          } else if (b.type === 'redacted_thinking') {
            yield { type: 'thinking', index: d.index, text: '' };
            sigs.set(d.index, { signature: b.data, redacted: true });
          }
          break;
        }
        case 'content_block_delta': {
          const x = d.delta || {};
          if (x.type === 'text_delta') yield { type: 'text', index: d.index, text: x.text };
          else if (x.type === 'thinking_delta') yield { type: 'thinking', index: d.index, text: x.thinking || '' };
          else if (x.type === 'signature_delta') sigs.set(d.index, { signature: (sigs.get(d.index)?.signature || '') + (x.signature || '') });
          else if (x.type === 'input_json_delta') yield { type: 'tool_json', index: d.index, json: x.partial_json || '' };
          break;
        }
        case 'content_block_stop': {
          const s = sigs.get(d.index);
          if (s?.signature) yield { type: 'signature', index: d.index, signature: s.signature, ...(s.redacted ? { redacted: true } : {}) };
          sigs.delete(d.index);
          yield { type: 'block_stop', index: d.index };
          break;
        }
        case 'message_delta':
          // Cumulative counts. Input and cache counts are only present when they changed (server tools).
          if (d.usage) {
            const u = d.usage;
            yield { type: 'usage', output: u.output_tokens, outputIsTotal: true, ...(Number.isFinite(u.input_tokens) ? { input: u.input_tokens } : {}), ...(Number.isFinite(u.cache_read_input_tokens) ? { cacheRead: u.cache_read_input_tokens } : {}), ...(Number.isFinite(u.cache_creation_input_tokens) ? { cacheWrite: u.cache_creation_input_tokens } : {}) };
          }
          if (d.delta?.stop_reason) yield { type: 'stop', reason: d.delta.stop_reason };
          break;
        case 'error': {
          const t = d.error?.type;
          const e = new Error(d.error?.message || 'The provider reported an error mid-stream');
          e.status = t === 'overloaded_error' ? 529 : t === 'rate_limit_error' ? 429 : t === 'api_error' ? 500 : 400;
          e.retryable = ['overloaded_error', 'api_error', 'rate_limit_error'].includes(t);
          throw e;
        }
        default:
          break;
      }
    }
  } catch (e) {
    throw streamError(e, signal);
  }
}

/** Signatures our OpenAI-compatible client stores (OpenRouter reasoning, Gemini tool signatures) are tagged. */
export const isForeignSignature = (sig) => /^(oc|gx):/.test(sig);

const imageBytes = (data) => Math.floor((String(data).replace(/=+$/, '').length * 3) / 4);

/** An Anthropic image block, or a text note when the image cannot be sent (unsupported type, too large). */
export function imageBlock(c) {
  const mime = String(c.mimeType || 'image/png').toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!IMAGE_TYPES.has(mime)) return { type: 'text', text: `[An attached ${mime} image was left out: only PNG, JPEG, GIF and WebP are supported.]` };
  if (imageBytes(c.data) > MAX_IMAGE_BYTES) return { type: 'text', text: `[An attached image was left out: it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.]` };
  return { type: 'image', source: { type: 'base64', media_type: mime, data: c.data } };
}

const hasText = (t) => typeof t === 'string' && t.trim() !== ''; // whitespace-only text blocks are rejected

/** OMP-shaped conversation -> Anthropic messages. Tool results are grouped into the user turn that follows the calls. */
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = [];
      for (const c of Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]) {
        if (c.type === 'text' && hasText(c.text)) blocks.push({ type: 'text', text: c.text });
        else if (c.type === 'image' && c.data) blocks.push(imageBlock(c));
      }
      if (blocks.length) out.push({ role: 'user', content: blocks });
    } else if (m.role === 'assistant') {
      const blocks = [];
      for (const c of m.content || []) {
        if (c.type === 'text' && hasText(c.text)) blocks.push({ type: 'text', text: c.text });
        else if (c.type === 'thinking') {
          // Signed thinking must go back unchanged (required with tool use); unsigned or foreign thinking is dropped.
          const sig = c.thinkingSignature;
          if (typeof sig !== 'string' || !sig || isForeignSignature(sig)) continue;
          if (c.redacted) blocks.push({ type: 'redacted_thinking', data: sig });
          else blocks.push({ type: 'thinking', thinking: c.thinking || '', signature: sig });
        } else if (c.type === 'toolCall') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'toolResult') {
      const text = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const images = (m.content || []).filter((c) => c.type === 'image' && c.data).map(imageBlock);
      const content = images.length ? [{ type: 'text', text: text || '(no output)' }, ...images] : text || '(no output)';
      // Tool results go first in the user turn that follows the tool calls.
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content, is_error: !!m.isError };
      if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}
