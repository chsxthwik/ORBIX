// Provider presets and the client for each API style. Models are always fetched live from the provider.
// Every client here gets: default max tokens from the catalog, thinking levels, and safe retries.
import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';
import { modelRecord, catalogModels } from './catalog.mjs';

// note: one plain line for the settings screen. keyUrl: where the user gets a key.
export const PRESETS = [
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', note: 'Claude models.', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', note: 'GPT and o-series models.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', note: 'Gemini models. Free tier available.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', note: 'Grok models.', keyUrl: 'https://console.x.ai/', oauth: true },
  { id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', note: 'Very fast open models.', keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', note: 'Mistral and Codestral models.', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', note: 'DeepSeek models. Low prices.', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', note: 'One account for hundreds of models.', keyUrl: 'https://openrouter.ai/settings/keys', oauth: true },
  { id: 'together', name: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', note: 'Open models (Llama, Qwen, DeepSeek...).', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks AI', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', note: 'Fast open models.', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  { id: 'cerebras', name: 'Cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', note: 'Very fast open models.', keyUrl: 'https://cloud.cerebras.ai/' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1', note: 'Kimi models.', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'zai', name: 'Z.ai (GLM)', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', note: 'GLM models.', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'qwen', name: 'Qwen (Alibaba Cloud)', type: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', note: 'Qwen models (international region).', keyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key' },
  { id: 'ollama', name: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', keyOptional: true, local: true, note: 'Models on this PC. No key. Ollama must be running.', keyUrl: 'https://ollama.com/download' },
  { id: 'lmstudio', name: 'LM Studio', type: 'openai', baseUrl: 'http://localhost:1234/v1', keyOptional: true, local: true, note: 'Models on this PC. No key. Start the LM Studio server first.', keyUrl: 'https://lmstudio.ai/' },
  { id: 'custom', name: 'Custom server', type: 'openai', baseUrl: '', keyOptional: true, editableUrl: true, note: 'Any server with the OpenAI chat API (vLLM, llama.cpp, a company gateway...).' },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id);
const presetByUrl = (u) => PRESETS.find((p) => p.baseUrl && u && p.baseUrl.replace(/\/+$/, '') === String(u).replace(/\/+$/, ''));

export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Map one of our levels onto the effort values a model accepts (null = not offered). */
export function mapEffort(level, values) {
  if (!values?.length) return ['low', 'medium', 'high'].includes(level) ? level : level === 'minimal' ? 'low' : level === 'xhigh' ? 'high' : null;
  if (values.includes(level)) return level;
  if (level === 'xhigh' && values.includes('max')) return 'max';
  return null;
}

/** Like mapEffort, but always returns something usable: the nearest value the model accepts. */
export function nearestEffort(level, values) {
  const exact = mapEffort(level, values);
  if (exact || !values?.length) return exact || 'medium';
  const want = RANK.indexOf(level);
  let best = null;
  for (const v of values) if (v !== 'none' && RANK.includes(v) && (best == null || Math.abs(RANK.indexOf(v) - want) < Math.abs(RANK.indexOf(best) - want))) best = v;
  return best || values[0];
}

/** How a model thinks: {kind: 'effort'|'budget'|'toggle'|'none', efforts}. Uses the catalog, then the model name. */
export function thinkingStyle(providerId, modelId) {
  const r = modelRecord(providerId, modelId);
  const type = presetById(providerId)?.type;
  const id = String(modelId || '').toLowerCase();
  if (type === 'anthropic' || (/claude/.test(id) && providerId === 'anthropic')) {
    // Claude 4.6 and newer: adaptive thinking + effort (a token budget is rejected on the newest ones).
    // Claude 3.7 / 4 / 4.5: a thinking token budget.
    const modern = /claude-(opus|sonnet|haiku)-(4-[6-9]|[5-9])|claude-(fable|mythos)/.test(id);
    if (r?.efforts?.length && (!r.budget || modern)) return { kind: 'effort', efforts: r.efforts };
    if (r?.budget || r?.reasoning) return { kind: 'budget' };
    if (modern) return { kind: 'effort', efforts: ['low', 'medium', 'high', 'max'] };
    if (/claude-(3-7|.*-4)/.test(id)) return { kind: 'budget' };
    return { kind: 'none' };
  }
  if (r) {
    if (!r.reasoning) return { kind: 'none' };
    // Gemini's OpenAI endpoint maps reasoning_effort onto thinking for every thinking model.
    if (providerId === 'google') return { kind: 'effort', efforts: r.efforts?.length ? r.efforts : ['minimal', 'low', 'medium', 'high'] };
    if (r.efforts?.length) return { kind: 'effort', efforts: r.efforts, toggle: r.toggle };
    if (r.toggle) return { kind: 'toggle' };
    return { kind: 'effort', efforts: null, toggle: false }; // reasoning model without listed options
  }
  // Unknown model: well-known reasoning families.
  if (providerId === 'openai' && /^(o\d|gpt-5)/.test(id)) return { kind: 'effort', efforts: ['minimal', 'low', 'medium', 'high'] };
  if (providerId === 'openrouter') return { kind: 'effort', efforts: null };
  return { kind: 'none' };
}

/** Thinking levels a model supports, always starting with 'off'. */
export function thinkingLevels(providerId, modelId) {
  try {
    const s = thinkingStyle(providerId, modelId);
    if (s.kind === 'none') return ['off'];
    if (s.kind === 'budget') return [...LEVELS];
    if (s.kind === 'toggle') return ['off', 'high'];
    if (providerId === 'openrouter') return [...LEVELS]; // OpenRouter maps every effort itself
    return ['off', ...LEVELS.slice(1).filter((l) => mapEffort(l, s.efforts))];
  } catch {
    return ['off'];
  }
}

/** Default max output tokens: the model's limit from the catalog, capped at 32000, else 8192. */
export function defaultMaxTokens(providerId, modelId) {
  const out = modelRecord(providerId, modelId)?.maxOutput;
  return out ? Math.min(out, 32000) : 8192;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Aborted'));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason || new Error('Aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

const MAX_ATTEMPTS = 4;

/** Wrap a stream factory: retry network errors, 408/429/5xx/529 until content has been yielded (then the error is tagged midStream). */
export async function* withRetries(make, signal) {
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const ev of make()) {
        if (ev.type !== 'start' && ev.type !== 'usage') yielded = true; // token counts alone are safe to repeat
        yield ev;
      }
      return;
    } catch (e) {
      if (e && typeof e === 'object' && yielded) e.midStream = true; // the caller may restart the whole turn
      if (signal?.aborted || yielded || !e?.retryable || attempt >= MAX_ATTEMPTS) throw e;
      let delayMs = Math.min(30000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      if (Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
        if (e.retryAfterMs > 60000) throw e; // the provider asks for a long pause: tell the user instead of hanging
        delayMs = Math.max(250, e.retryAfterMs);
      }
      yield { type: 'retry', attempt: attempt + 1, delayMs, reason: e.message };
      await sleep(delayMs, signal);
    }
  }
}

/** A uniform {listModels, stream} for a provider type. */
export function clientFor(type) {
  const impl = type === 'anthropic' ? anthropic : openai;
  return {
    async listModels(a) {
      const providerId = a.providerId || presetByUrl(a.baseUrl)?.id || '';
      try {
        return await impl.listModels({ ...a, providerId });
      } catch (e) {
        // A few providers have no model list endpoint: fall back to the catalog's list for them.
        if ((e.status === 404 || e.status === 405) && catalogModels(providerId).length) return catalogModels(providerId);
        throw e;
      }
    },
    stream(a) {
      const providerId = a.providerId || presetByUrl(a.baseUrl)?.id || (type === 'anthropic' ? 'anthropic' : '');
      const maxTokens = Number.isFinite(a.maxTokens) && a.maxTokens > 0 ? a.maxTokens : defaultMaxTokens(providerId, a.model);
      const thinking = LEVELS.includes(a.thinking) ? a.thinking : 'off';
      const style = thinkingStyle(providerId, a.model);
      const maxOutput = modelRecord(providerId, a.model)?.maxOutput || null;
      const effort = thinking === 'off' ? null : style.kind === 'effort' ? nearestEffort(thinking, style.efforts) : thinking;
      const args = { ...a, providerId, maxTokens, thinking, style, effort, maxOutput };
      if (type === 'anthropic') return withRetries(() => anthropic.streamTurn({ ...args, messages: anthropic.toAnthropicMessages(a.messages) }), a.signal);
      const interleaved = modelRecord(providerId, a.model)?.interleaved || null;
      return withRetries(() => openai.streamTurn({ ...args, interleaved }), a.signal);
    },
  };
}
