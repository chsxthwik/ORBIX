// Model facts (context window, output limit, prices, reasoning, vision) from the public models.dev catalog.
// Fetched at most once a day and cached in DATA_DIR/cache/models-dev.json, so it works offline.
// Nothing here ever throws to callers: unknown models just return null.
import { replaceFile } from '../util.mjs';
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
  opencode: 'opencode',
  'opencode-go': null, // the Go plan's models are matched by id
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
      replaceFile(tmp, cacheFile());
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

// What a provider says about its own models, from its model list (the ChatGPT plan reports each model's context
// window, effort levels and default effort). It is more accurate than the catalog, so it wins field by field.
const live = new Map(); // provider + '\n' + model id -> { contextWindow, efforts, defaultEffort, vision, cost }
const BLANK = { contextWindow: null, maxOutput: null, cost: { input: null, output: null, cacheRead: null, cacheWrite: null }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null };

/** Record facts a provider reported about one of its models (fields left undefined keep the catalog's value). */
export function setLiveInfo(providerId, modelId, facts) {
  if (!providerId || !modelId || !facts) return;
  const clean = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined));
  if (clean.efforts) clean.reasoning = clean.efforts.length > 0;
  live.set(`${providerId}\n${modelId}`, clean);
}

// The effort levels a provider's API actually accepted for a model, learned from its own answers (a request with a
// level the model does not take is refused, free of charge, with the list of levels it does take). This is the
// final word: model lists can advertise a level the API refuses, or leave out one it takes. Kept on disk for a week.
const LEARN_TTL = 7 * DAY;
const learnFile = () => path.join(DATA_DIR, 'cache', 'effort-levels.json');
let learned = null; // key -> { efforts, at }
function learnedMap() {
  if (learned) return learned;
  learned = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(learnFile(), 'utf8')) || {})) if (Array.isArray(v?.efforts) && Number.isFinite(v.at)) learned.set(k, v);
  } catch {}
  return learned;
}

/** Remember the effort levels a provider's API accepts for a model ('none' among them means thinking can be off). */
export function learnEfforts(providerId, modelId, efforts) {
  if (!providerId || !modelId || !Array.isArray(efforts) || !efforts.length) return;
  learnedMap().set(`${providerId}\n${modelId}`, { efforts: [...new Set(efforts.map(String))], at: Date.now() });
  try {
    fs.mkdirSync(path.dirname(learnFile()), { recursive: true });
    const tmp = learnFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(learned)));
    replaceFile(tmp, learnFile());
  } catch {}
}

/** True when the accepted levels of a model were learned within the last week. */
export function effortsKnown(providerId, modelId) {
  const v = learnedMap().get(`${providerId}\n${modelId}`);
  return !!v && Date.now() - v.at < LEARN_TTL;
}

/** Raw slim record (with efforts/budget/toggle/interleaved/canonical) or null. */
export function modelRecord(providerId, modelId) {
  const key = `${providerId}\n${String(modelId)}`;
  const own = modelId ? live.get(key) : null;
  const taught = modelId ? learnedMap().get(key) : null;
  const base = catalogRecord(providerId, modelId);
  if (!own && !taught) return base;
  const r = { ...(base || BLANK), ...(own || {}), cost: own?.cost ? { ...BLANK.cost, ...own.cost } : (base || BLANK).cost };
  if (taught && Date.now() - taught.at < LEARN_TTL) Object.assign(r, { efforts: taught.efforts, reasoning: true });
  return r;
}

function catalogRecord(providerId, modelId) {
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
  return { contextWindow: r.contextWindow, maxOutput: r.maxOutput, cost: { ...r.cost }, reasoning: r.reasoning, vision: r.vision, tools: r.tools, efforts: r.efforts, defaultEffort: r.defaultEffort || null, interleaved: r.interleaved };
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
