// Provider presets and the client for each API style. Models are always fetched live from the provider.
// Every client here gets: default max tokens from the catalog, thinking levels, and safe retries.
import * as anthropic from './anthropic.mjs';
import * as openai from './openai.mjs';
import { modelRows } from './openai.mjs';
import * as chatgpt from './chatgpt.mjs';
import { modelRecord, catalogModels, learnEfforts } from './catalog.mjs';
import { supportedEfforts } from './chatgpt.mjs';

// note: one plain line for the settings screen. keyUrl: where the user gets a key. listsFacts: its model list reports
// each model's context window and effort levels, which are more accurate than the catalog (see catalog.setLiveInfo).
export const PRESETS = [
  { id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', note: 'Claude models.', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'chatgpt', name: 'ChatGPT', type: 'chatgpt', baseUrl: 'https://chatgpt.com/backend-api/codex', note: 'GPT models on your ChatGPT Plus or Pro plan, with no API key.', oauth: true, signInOnly: true, listsFacts: true },
  { id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', note: 'GPT and o-series models.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'google', name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', note: 'Gemini models, with a free tier.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', note: 'Grok models.', keyUrl: 'https://console.x.ai/', oauth: true },
  { id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', note: 'Very fast open models on Groq chips.', keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', note: 'Mistral and Codestral models.', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', note: 'DeepSeek models at low prices.', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'opencode', name: 'OpenCode', type: 'openai', baseUrl: 'https://opencode.ai/inference/openai/v1', note: 'Claude, GPT, Gemini and open models, paid as you go. Sign in, or paste an oc_sk_ key.', keyUrl: 'https://opencode.ai/console', oauth: true },
  { id: 'opencode-go', name: 'OpenCode Go', type: 'openai', baseUrl: 'https://opencode.ai/inference/go/openai/v1', note: 'Open models on your OpenCode Go plan. Paste your Go API key to connect.', keyUrl: 'https://opencode.ai/console' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', note: 'One account for hundreds of models.', keyUrl: 'https://openrouter.ai/settings/keys', oauth: true },
  { id: 'together', name: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', note: 'Open models such as Llama, Qwen and DeepSeek.', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks AI', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', note: 'Open models, with fast serving and fine-tuning.', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys' },
  { id: 'cerebras', name: 'Cerebras', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', note: 'Very fast open models on Cerebras wafer-scale chips.', keyUrl: 'https://cloud.cerebras.ai/' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1', note: 'Kimi models.', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'zai', name: 'Z.ai (GLM)', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', note: 'GLM models.', keyUrl: 'https://z.ai/manage-apikey/apikey-list' },
  { id: 'qwen', name: 'Qwen (Alibaba Cloud)', type: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', note: 'Qwen models, served from the international region.', keyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key' },
  { id: 'ollama', name: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', keyOptional: true, local: true, note: 'Models on this PC, with no key. Ollama must be running.', keyUrl: 'https://ollama.com/download' },
  { id: 'lmstudio', name: 'LM Studio', type: 'openai', baseUrl: 'http://localhost:1234/v1', keyOptional: true, local: true, note: 'Models on this PC, with no key. Start the LM Studio server first.', keyUrl: 'https://lmstudio.ai/' },
  { id: 'custom', name: 'Custom server', type: 'openai', baseUrl: '', keyOptional: true, editableUrl: true, note: 'Any server with the OpenAI chat API, such as vLLM, llama.cpp or a company gateway.' },
];

export const presetById = (id) => PRESETS.find((p) => p.id === id);
const presetByUrl = (u) => PRESETS.find((p) => p.baseUrl && u && p.baseUrl.replace(/\/+$/, '') === String(u).replace(/\/+$/, ''));

// Thinking levels, lightest first. A model offers the ones its provider accepts; 'off' only when it can stop thinking.
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Map one of our levels onto the effort values a model accepts (null = not offered). */
export function mapEffort(level, values) {
  if (!values?.length) return ['low', 'medium', 'high'].includes(level) ? level : level === 'minimal' ? 'low' : level === 'xhigh' ? 'high' : null;
  return values.includes(level) ? level : null;
}

/** Like mapEffort, but always returns something usable: the nearest value the model accepts. */
export function nearestEffort(level, values) {
  const exact = mapEffort(level, values);
  if (exact || !values?.length) return exact || 'medium';
  const want = RANK.indexOf(level);
  let best = null;
  if (level === 'xhigh' && values.includes('max')) return 'max'; // a model with max but no xhigh: max is the next step up
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
    // Gemini 2.5 Flash and Flash-Lite can stop thinking ('none'); 2.5 Pro and Gemini 3 and newer cannot.
    if (providerId === 'google') {
      const efforts = r.efforts?.length ? [...r.efforts] : ['minimal', 'low', 'medium', 'high'];
      if (/gemini-2-?\.?5-flash/.test(id) && !efforts.includes('none')) efforts.unshift('none');
      return { kind: 'effort', efforts };
    }
    if (r.efforts?.length) return { kind: 'effort', efforts: r.efforts, toggle: r.toggle };
    if (r.toggle) return { kind: 'toggle' };
    return { kind: 'effort', efforts: null, toggle: false }; // reasoning model without listed options
  }
  // Unknown model: well-known reasoning families.
  if (providerId === 'openai' && /^(o\d|gpt-5)/.test(id)) return { kind: 'effort', efforts: ['minimal', 'low', 'medium', 'high'] };
  if (providerId === 'chatgpt') return { kind: 'effort', efforts: ['low', 'medium', 'high', 'xhigh'] }; // every model in Codex's catalog
  if (providerId === 'openrouter') return { kind: 'effort', efforts: null };
  return { kind: 'none' };
}

/**
 * Whether the model can be asked not to think. Claude, budget and on/off models can; an effort model only when it
 * accepts the effort 'none' (asking for less is not off: a model that always reasons would silently use its
 * default). ChatGPT-plan models always reason. An effort model with unknown levels keeps 'off' (its API decides).
 */
export function canStopThinking(providerId, modelId) {
  const s = thinkingStyle(providerId, modelId);
  if (s.kind !== 'effort' || presetById(providerId)?.type === 'anthropic') return true;
  if (!s.efforts?.length) return providerId !== 'chatgpt';
  return s.efforts.includes('none') || !!s.toggle;
}

/** Thinking levels a model supports: 'off' first when it can stop thinking, then its levels, lightest first. */
export function thinkingLevels(providerId, modelId) {
  try {
    const s = thinkingStyle(providerId, modelId);
    if (s.kind === 'none') return ['off'];
    if (s.kind === 'budget') return LEVELS.slice(0, 6); // off to xhigh: token budgets (see anthropic.mjs)
    if (s.kind === 'toggle') return ['off', 'high'];
    if (providerId === 'openrouter') return LEVELS.slice(0, 6); // OpenRouter maps these efforts itself
    const levels = LEVELS.slice(1).filter((l) => mapEffort(l, s.efforts));
    return canStopThinking(providerId, modelId) || !levels.length ? ['off', ...levels] : levels;
  } catch {
    return ['off'];
  }
}

/**
 * The level a session starts at until you choose one: the level the provider itself uses by default (the ChatGPT plan
 * reports one per model), else off, else medium for a model that always thinks, else its lightest level.
 */
export function defaultThinking(providerId, modelId) {
  const levels = thinkingLevels(providerId, modelId);
  const d = modelRecord(providerId, modelId)?.defaultEffort;
  if (d && levels.includes(d)) return d;
  if (levels.includes('off')) return 'off';
  return levels.includes('medium') ? 'medium' : levels[0] || 'off';
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
/** How long a model list may take before the provider is reported as not answering. */
export const LIST_TIMEOUT = 20000;

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

/**
 * Run a turn; if the API refuses the effort level and lists the ones the model takes (OpenAI and the ChatGPT plan
 * do, before any work is done), remember them and run the turn once more at the nearest accepted level.
 */
async function* effortGuard(args, run) {
  try {
    yield* run(args);
  } catch (e) {
    const tried = args.effort || (args.thinking === 'off' ? 'none' : null);
    const allowed = e?.status === 400 && tried ? supportedEfforts(e.message, tried) : null;
    if (!allowed || !args.providerId || !args.model) throw e;
    learnEfforts(args.providerId, args.model, allowed);
    const style = thinkingStyle(args.providerId, args.model); // built from the levels the provider accepted
    const thinking = args.thinking === 'off' && !allowed.includes('none') ? nearestEffort('low', allowed) : args.thinking;
    const effort = thinking === 'off' ? null : nearestEffort(thinking, allowed);
    yield* run({ ...args, style, effort, thinking });
  }
}

/** A uniform {listModels, stream} for a provider type. */
export function clientFor(type) {
  const impl = type === 'anthropic' ? anthropic : type === 'chatgpt' ? chatgpt : openai;
  return {
    async listModels(a) {
      const providerId = a.providerId || presetByUrl(a.baseUrl)?.id || '';
      const preset = presetById(providerId);
      try {
        return await impl.listModels({ ...a, providerId });
      } catch (e) {
        // A few providers have no model list endpoint: fall back to the catalog's list for them (chat models only).
        if ((e.status === 404 || e.status === 405) && catalogModels(providerId).length) return modelRows(catalogModels(providerId));
        if (a.signal?.aborted && a.signal.reason?.name === 'TimeoutError') throw Object.assign(new Error(`${preset?.name || a.baseUrl} did not answer within ${Math.round(LIST_TIMEOUT / 1000)} seconds. Check your connection${preset?.local || preset?.editableUrl ? ' and that the server is running' : ''}, then try again.`), { status: 504, retryable: true });
        // A local app that is not running, or a custom address that is wrong, gets a plain explanation.
        if (!e.status && (preset?.local || preset?.editableUrl) && /Cannot reach/.test(e.message)) throw Object.assign(new Error(`${preset.local ? preset.name : 'The server'} is not answering at ${a.baseUrl}. ${preset.local ? `Start ${preset.name} and try again.` : 'Check the address and that the server is running.'}`), { retryable: true });
        if (e.status === 404 && preset?.editableUrl) throw Object.assign(new Error(`There is no model list at ${String(a.baseUrl).replace(/\/+$/, '')}/models. Check the server address: it usually ends in /v1.`), { status: 404 });
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
      const interleaved = type === 'chatgpt' ? null : modelRecord(providerId, a.model)?.interleaved || null;
      const turn = (x) => (type === 'chatgpt' ? chatgpt.streamTurn(x) : openai.streamTurn({ ...x, interleaved }));
      return effortGuard(args, (x) => withRetries(() => turn(x), a.signal));
    },
  };
}
