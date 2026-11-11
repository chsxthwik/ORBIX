// Model facts (context window, output limit, prices, reasoning, vision) from the public models.dev catalog.
// Fetched at most once a day and cached in DATA_DIR/cache/models-dev.json, so it works offline.
// Nothing here ever throws to callers: unknown models just return null.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.mjs';

const URL_ = 'https://models.dev/api.json';
const DAY = 24 * 3600 * 1000;
const cacheFile = () => path.join(DATA_DIR, 'cache', 'models-dev.json');

/** Our provider ids -> models.dev provider ids (null = local/custom: match by model id only). */
const MODELS_DEV_ID = {
  anthropic: 'anthropic',
  openai: 'openai',
  chatgpt: 'openai', // the same models, used through a ChatGPT plan
  google: 'google',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  deepseek: 'deepseek',
  openrouter: 'openrouter',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
  cerebras: 'cerebras',
  moonshot: 'moonshotai',
  zai: 'zai',
  qwen: 'alibaba',
  lmstudio: 'lmstudio',
  ollama: null,
  custom: null,
};
// When a model is matched by id alone, prefer the maker's own listing.
const FIRST_PARTY = ['anthropic', 'openai', 'google', 'xai', 'mistral', 'deepseek', 'moonshotai', 'zai', 'alibaba', 'groq', 'cerebras', 'togetherai', 'fireworks-ai', 'openrouter'];

let cat = null; // { fetchedAt, providers: { pid: { mid: slim } } }
let byId = null; // normalised model id -> slim (first-party first)
let loading = null;
let lastTry = 0;

const norm = (id) => String(id || '').toLowerCase().replace(/^models\//, '').replace(/\./g, '-');

function slim(m) {
  const c = m.cost || {};
  const opts = Array.isArray(m.reasoning_options) ? m.reasoning_options : [];
  return {
    contextWindow: m.limit?.context || null,
    maxOutput: m.limit?.output || null,
    cost: { input: c.input ?? null, output: c.output ?? null, cacheRead: c.cache_read ?? null, cacheWrite: c.cache_write ?? null },
    reasoning: !!m.reasoning,
    vision: Array.isArray(m.modalities?.input) ? m.modalities.input.includes('image') : !!m.attachment,
    tools: m.tool_call !== false,
    efforts: opts.find((o) => o.type === 'effort')?.values || null,
    budget: opts.some((o) => o.type === 'budget_tokens'),
    toggle: opts.some((o) => o.type === 'toggle'),
    interleaved: m.interleaved && typeof m.interleaved === 'object' ? m.interleaved.field || null : null,
    canonical: m.canonical_model_id || null,
  };
}

function slimAll(raw) {
  const providers = {};
  for (const [pid, p] of Object.entries(raw || {})) {
    if (!p || typeof p.models !== 'object') continue;
    const models = {};
    for (const [mid, m] of Object.entries(p.models)) if (m && typeof m === 'object') models[mid] = slim(m);
    providers[pid] = models;
  }
  return providers;
}

function index() {
  byId = new Map();
  const order = [...FIRST_PARTY, ...Object.keys(cat.providers).filter((p) => !FIRST_PARTY.includes(p))];
  for (const pid of order) {
    for (const [mid, info] of Object.entries(cat.providers[pid] || {})) {
      for (const k of [norm(mid), norm(mid.split('/').pop()), info.canonical && norm(info.canonical)]) if (k && !byId.has(k)) byId.set(k, info);
    }
  }
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (j && j.providers && typeof j.providers === 'object') return j;
  } catch {}
  return null;
}

async function fetchFresh() {
  lastTry = Date.now();
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (!r.ok) return false;
    const providers = slimAll(await r.json());
    if (!Object.keys(providers).length) return false;
    cat = { fetchedAt: Date.now(), providers };
    index();
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      const tmp = cacheFile() + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cat));
      fs.renameSync(tmp, cacheFile());
    } catch {}
    return true;
  } catch {
    return false;
  }
}

/**
 * Load the catalog (call once at startup; safe to call again). Uses the cache at once if there is one and
 * refreshes it in the background when it is older than a day. Never throws.
 */
export function loadCatalog() {
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!cat) {
        const c = readCache();
        if (c) {
          cat = c;
          index();
        }
      }
      const stale = !cat || Date.now() - (cat.fetchedAt || 0) > DAY;
      if (stale && Date.now() - lastTry > 10 * 60 * 1000) {
        if (cat) fetchFresh(); // background; the cached copy is good enough meanwhile
        else await fetchFresh();
      }
    } catch {}
    loading = null;
    return !!cat;
  })();
  return loading;
}

function maybeRefresh() {
  if (!loading && (!cat || Date.now() - (cat.fetchedAt || 0) > DAY) && Date.now() - lastTry > 10 * 60 * 1000) loadCatalog();
}

/** Raw slim record (with efforts/budget/toggle/interleaved/canonical) or null. */
export function modelRecord(providerId, modelId) {
  try {
    maybeRefresh();
    if (!cat || !modelId) return null;
    const id = String(modelId).replace(/^models\//, '');
    const pid = MODELS_DEV_ID[providerId] === undefined ? providerId : MODELS_DEV_ID[providerId];
    const own = pid ? cat.providers[pid] : null;
    if (own) {
      if (own[id]) return own[id];
      const n = norm(id);
      for (const [mid, info] of Object.entries(own)) if (norm(mid) === n) return info;
    }
    // Aggregators, local servers and custom gateways: match by model id ("anthropic/claude-x", "qwen3:8b" ...).
    const n = norm(id);
    const tries = [n, norm(n.split('/').pop()), norm(n.split(':')[0]), norm(n.split('/').pop().split(':')[0])];
    for (const k of tries) if (k && byId.has(k)) return byId.get(k);
    return null;
  } catch {
    return null;
  }
}

/** {contextWindow, maxOutput, cost:{input,output,cacheRead,cacheWrite} (USD per 1M tokens), reasoning, vision} or null. */
export function modelInfo(providerId, modelId) {
  const r = modelRecord(providerId, modelId);
  if (!r) return null;
  return { contextWindow: r.contextWindow, maxOutput: r.maxOutput, cost: { ...r.cost }, reasoning: r.reasoning, vision: r.vision, tools: r.tools, efforts: r.efforts, interleaved: r.interleaved };
}

/** Models the catalog lists for one provider (used when a provider has no /models endpoint). */
export function catalogModels(providerId) {
  try {
    const pid = MODELS_DEV_ID[providerId];
    if (!cat || !pid || !cat.providers[pid]) return [];
    return Object.keys(cat.providers[pid]).map((id) => ({ id, name: id }));
  } catch {
    return [];
  }
}

/** USD for one usage record {input, output, cacheRead, cacheWrite}. null when the price is unknown. */
export function costOf(info, usage) {
  try {
    const c = info?.cost;
    if (!c || c.input == null || c.output == null || !usage) return null;
    const n = (v) => (Number.isFinite(+v) ? +v : 0);
    const usd = n(usage.input) * c.input + n(usage.output) * c.output + n(usage.cacheRead) * (c.cacheRead ?? c.input) + n(usage.cacheWrite) * (c.cacheWrite ?? c.input);
    return usd / 1e6;
  } catch {
    return null;
  }
}
