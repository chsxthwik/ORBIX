// ChatGPT plan client: the Responses API behind chatgpt.com/backend-api/codex, used the way the OpenAI Codex CLI uses
// it after "Sign in with ChatGPT" (github.com/openai/codex, codex-rs). Requests count against the user's ChatGPT plan;
// no API key is involved. Unofficial: OpenAI can change this endpoint at any time.
// Emits the same normalised events as anthropic.mjs and openai.mjs.
import crypto from 'node:crypto';
import { parseSSE, httpError, post, streamError, imageBlock } from './anthropic.mjs';

const join = (base, p) => base.replace(/\/+$/, '') + p;

/** The claims of a JWT, unverified (read only to find the account it belongs to and when it expires). */
export function jwtClaims(token) {
  try {
    const part = String(token || '').split('.')[1];
    return part ? JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) : null;
  } catch {
    return null;
  }
}
/** ChatGPT account details carried in an OpenAI ID or access token: { accountId, plan }. */
export function chatgptAuth(token) {
  const a = jwtClaims(token)?.['https://api.openai.com/auth'];
  return a && typeof a === 'object' ? { accountId: a.chatgpt_account_id || null, plan: a.chatgpt_plan_type || null } : null;
}

const SESSION = crypto.randomUUID(); // one id per ORBIX run, like a Codex session
// The Codex version these requests present. The model list only offers models whose minimal_client_version is at
// or below it (0.155.0 covers every model in Codex's catalog as of 2026-11).
export const CLIENT_VERSION = '0.155.0';
function headers(accessToken, accept = 'text/event-stream') {
  const accountId = chatgptAuth(accessToken)?.accountId;
  if (!accountId) throw Object.assign(new Error('The ChatGPT sign-in is not valid any more. Sign in with ChatGPT again in Settings.'), { status: 401 });
  return {
    'content-type': 'application/json',
    accept,
    authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    originator: 'codex_cli_rs',
    version: CLIENT_VERSION,
    'user-agent': `codex_cli_rs/${CLIENT_VERSION} (ORBIX)`,
    'session-id': SESSION,
  };
}

// Codex's bundled catalog (models-manager/models.json), used only when the live list cannot be read.
export const PLAN_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

/** The models this ChatGPT plan offers (GET /models, as Codex reads it). Also proves the sign-in works. */
export async function listModels({ apiKey, baseUrl, signal }) {
  const r = await post(join(baseUrl, `/models?client_version=${CLIENT_VERSION}`), { headers: headers(apiKey, 'application/json'), signal }, baseUrl);
  if (r.status === 404) return PLAN_MODELS.map((id) => ({ id, name: id }));
  if (!r.ok) throw await planError(r);
  const j = await r.json().catch(() => ({}));
  const rows = (Array.isArray(j.models) ? j.models : []).filter((m) => m?.slug && (m.visibility || 'list') === 'list');
  if (!rows.length) return PLAN_MODELS.map((id) => ({ id, name: id }));
  return rows.map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
}

/** A clear error for the plan's own limits (usage limit with its reset time, no plan), else the usual HTTP error. */
async function planError(r) {
  const text = await r.clone().text().catch(() => '');
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  const e = j?.error || j?.detail || {};
  const type = e.type || e.code || '';
  if (r.status === 429 && /usage_limit/.test(type)) {
    const secs = Number(e.resets_at) ? Number(e.resets_at) - Date.now() / 1000 : Number(e.resets_in_seconds);
    const when = Number.isFinite(secs) && secs > 0 ? (secs < 3600 ? `in ${Math.ceil(secs / 60)} min` : `in ${Math.round(secs / 3600)} h`) : 'later';
    return Object.assign(new Error(`You have reached your ChatGPT plan's usage limit${e.plan_type ? ` (${e.plan_type})` : ''}. It resets ${when}.`), { status: 429, retryable: false });
  }
  if (/usage_not_included/.test(type)) return Object.assign(new Error('Your ChatGPT plan does not include Codex usage. Plus, Pro, Business, Edu or Enterprise plans do.'), { status: 403 });
  if (/insufficient_quota|credit_balance/.test(`${type} ${e.code || ''}`)) return Object.assign(new Error('Your ChatGPT plan has no credits left for this.'), { status: 402 });
  if (r.status === 401) return Object.assign(new Error('The ChatGPT sign-in has expired. Sign in with ChatGPT again in Settings.'), { status: 401 });
  if (r.status === 403 && /plan|subscription|workspace/i.test(text)) return Object.assign(new Error('This ChatGPT account cannot use these models. A Plus, Pro, Business, Edu or Enterprise plan is needed.'), { status: 403 });
  return httpError(r);
}

// Reasoning items come back encrypted (store: false) and must be sent again with the next request: kept on a
// thinking item as 'cx:' + JSON array of reasoning items.
const parseCx = (sig) => {
  if (typeof sig !== 'string' || !sig.startsWith('cx:')) return [];
  try {
    const v = JSON.parse(sig.slice(3));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function inputImage(c) {
  const b = imageBlock(c);
  return b.type === 'image' ? { type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}` } : { type: 'input_text', text: b.text };
}

/** Internal conversation -> Responses API input items. */
export function toResponsesInput(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content = [];
      for (const c of Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]) {
        if (c.type === 'text' && c.text) content.push({ type: 'input_text', text: c.text });
        else if (c.type === 'image' && c.data) content.push(inputImage(c));
      }
      if (content.length) out.push({ type: 'message', role: 'user', content });
    } else if (m.role === 'assistant') {
      for (const c of m.content || []) {
        if (c.type === 'thinking') out.push(...parseCx(c.thinkingSignature));
        else if (c.type === 'text' && c.text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: c.text }] });
        else if (c.type === 'toolCall') out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments || {}) });
      }
    } else if (m.role === 'toolResult') {
      const text = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '(no output)';
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: text });
      const images = (m.content || []).filter((c) => c.type === 'image' && c.data).map(inputImage);
      if (images.length) out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Images returned by the tool call above:' }, ...images] });
    }
  }
  return out;
}

/** Request body for one turn. */
export function buildBody({ model, system, messages, tools, thinking = 'off', effort }) {
  const body = {
    model,
    // Like current Codex: the instructions travel as the first input item, a developer message.
    input: [...(system ? [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: system }] }] : []), ...toResponsesInput(messages)],
    tools: (tools || []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false })),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: SESSION,
  };
  if (thinking !== 'off' && effort) body.reasoning = { effort, summary: 'auto' };
  return body;
}

export async function* streamTurn({ apiKey, baseUrl, signal, ...rest }) {
  const body = buildBody(rest);
  const r = await post(join(baseUrl, '/responses'), { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal }, baseUrl);
  if (!r.ok) throw await planError(r);
  yield { type: 'start' };
  const calls = new Map(); // output_index -> { idx, args, started }
  const reasoning = [];
  let sawThinking = false;
  let stopped = false;
  const finish = function* (reason, usage) {
    if (reasoning.length) {
      if (!sawThinking) yield { type: 'thinking', index: -1, text: '' };
      yield { type: 'signature', index: -1, signature: 'cx:' + JSON.stringify(reasoning) };
    }
    for (const c of calls.values()) if (c.started) yield { type: 'block_stop', index: c.idx };
    if (usage) {
      const cached = usage.input_tokens_details?.cached_tokens || 0;
      yield { type: 'usage', input: Math.max(0, (usage.input_tokens || 0) - cached), output: usage.output_tokens || 0, cacheRead: cached, cacheWrite: 0 };
    }
    yield { type: 'stop', reason: reason || ([...calls.values()].some((c) => c.started) ? 'tool_use' : 'end_turn') };
    stopped = true;
  };
  try {
    for await (const { data } of parseSSE(r.body, signal)) {
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        continue;
      }
      switch (d.type) {
        case 'response.output_text.delta':
          if (d.delta) yield { type: 'text', index: 0, text: d.delta };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          if (d.delta) {
            sawThinking = true;
            yield { type: 'thinking', index: -1, text: d.delta };
          }
          break;
        case 'response.reasoning_summary_part.added':
          if (sawThinking) yield { type: 'thinking', index: -1, text: '\n\n' };
          break;
        case 'response.output_item.added':
          if (d.item?.type === 'function_call') {
            const c = { idx: 1000 + calls.size, args: '', started: true };
            calls.set(d.output_index, c);
            yield { type: 'tool_start', index: c.idx, id: d.item.call_id || `call_${c.idx}`, name: d.item.name || '' };
          }
          break;
        case 'response.function_call_arguments.delta': {
          const c = calls.get(d.output_index);
          if (c && d.delta) {
            c.args += d.delta;
            yield { type: 'tool_json', index: c.idx, json: d.delta };
          }
          break;
        }
        case 'response.output_item.done': {
          const it = d.item || {};
          if (it.type === 'reasoning' && it.encrypted_content) reasoning.push({ type: 'reasoning', summary: Array.isArray(it.summary) ? it.summary : [], encrypted_content: it.encrypted_content });
          if (it.type === 'function_call') {
            // Codex reads calls from here; the argument deltas are optional. A call never announced is started now.
            let c = calls.get(d.output_index);
            if (!c) {
              c = { idx: 1000 + calls.size, args: '', started: true };
              calls.set(d.output_index ?? `done${calls.size}`, c);
              yield { type: 'tool_start', index: c.idx, id: it.call_id || `call_${c.idx}`, name: it.name || '' };
            }
            if (!c.args && it.arguments) {
              c.args = it.arguments;
              yield { type: 'tool_json', index: c.idx, json: it.arguments };
            }
          }
          break;
        }
        case 'response.completed':
          yield* finish(null, d.response?.usage);
          break;
        case 'response.incomplete':
          yield* finish(d.response?.incomplete_details?.reason === 'max_output_tokens' ? 'length' : null, d.response?.usage);
          break;
        case 'response.failed':
        case 'error': {
          const er = d.response?.error || d.error || d;
          const e = new Error(er.message || 'ChatGPT reported an error');
          e.status = /rate|limit/i.test(er.code || er.type || '') ? 429 : 500;
          e.retryable = !/usage_limit|context_length|invalid/i.test(`${er.code} ${er.type}`);
          throw e;
        }
        default:
          break;
      }
      if (stopped) break;
    }
  } catch (e) {
    throw streamError(e, signal);
  }
  if (!stopped) yield* finish();
}
