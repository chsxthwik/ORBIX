import { contextTokens, estimateTokens, lastMarker } from './compact.mjs';

const size = (text) => Math.ceil(text.length / 3.6);
const keys = ['system', 'rules', 'files', 'history', 'results'];
const sum = (weights) => keys.reduce((n, k) => n + (weights[k] || 0), 0);
export const promptWeights = (system, rules, tools) => ({
  system: Math.max(0, size(system) - size(rules)) + size(tools.length ? JSON.stringify(tools) : ''),
  rules: size(rules),
});

/** Estimate the visible request parts, without counting inlined attachments twice. */
export function contextWeights(messages, prompt = {}) {
  const weights = { system: prompt.system || 0, rules: prompt.rules || 0, files: 0, history: 0, results: 0 };
  for (const m of messages) {
    if (m.role === 'toolResult') weights.results += estimateTokens([m]);
    else if (m.role === 'user' && Array.isArray(m.content)) {
      // contextMessages appends the serialized attachments as the last text block.
      const at = m.attachments?.length ? m.content.length - 1 : -1;
      const files = m.content.filter((c, i) => i === at || c.type === 'image');
      const history = m.content.filter((c, i) => i !== at && c.type !== 'image');
      weights.files += estimateTokens([{ content: files }]);
      weights.history += estimateTokens([{ content: history }]);
    } else weights.history += estimateTokens([m]);
  }
  return weights;
}

export const contextEpoch = (messages) => {
  const m = messages[lastMarker(messages)];
  return m?.id || m?.timestamp || null;
};

/** Integer allocations add up to the total, including when some parts round down. */
function allocate(weights, total) {
  const raw = sum(weights);
  if (!raw) return keys.map((key) => ({ key, tokens: key === 'history' ? total : 0 }));
  const rows = keys.map((key) => {
    const share = weights[key] / raw * total;
    return { key, tokens: Math.floor(share), fraction: share % 1 };
  });
  const left = total - rows.reduce((n, r) => n + r.tokens, 0);
  for (const row of [...rows].sort((a, b) => b.fraction - a.fraction).slice(0, left)) row.tokens++;
  return rows.map(({ key, tokens }) => ({ key, tokens }));
}

export function contextBudget({ messages, context, prompt, provider, model, window, windowKnown, planMode }) {
  const report = messages.findLast((m) => m.role === 'assistant' && !m.discard && m.contextMeasure &&
    ((m.provider === provider && m.model === model) || (planMode && m.contextMeasure.plan)));
  const measure = report?.contextMeasure;
  // Retain the provider counters already saved by pre-budget versions of ORBIX.
  const marker = messages[lastMarker(messages)];
  const legacy = !measure && messages.findLast((m) => m.role === 'assistant' && !m.discard && !m.contextMeasure &&
    m.provider === provider && m.model === model && m.usage &&
    (!marker || m.timestamp > marker.timestamp) &&
    ((m.usage.input || 0) + (m.usage.cacheRead || 0) + (m.usage.cacheWrite || 0) > 0));
  const legacyInput = legacy ? (legacy.usage.input || 0) + (legacy.usage.cacheRead || 0) + (legacy.usage.cacheWrite || 0) : 0;
  const weights = contextWeights(context, prompt || measure?.weights);
  const raw = sum(weights);
  const sameEpoch = measure && measure.epoch === contextEpoch(messages);
  // Provider usage includes everything in the prompt, including cached input and message/template overhead.
  // Estimate only changes since that request, or the new total after a compaction. The per-part split is always approximate.
  const scale = measure ? measure.input / Math.max(1, sum(measure.weights)) : 1;
  const latest = sameEpoch && messages.at(-1) === report && weights.system === measure.weights.system && weights.rules === measure.weights.rules;
  const legacyOutput = legacy ? legacy.usage.output || 0 : 0;
  const tokens = Math.max(0, Math.round(latest ? measure.input + measure.output
    : sameEpoch ? measure.input + measure.output + (raw - sum(measure.weights) - estimateTokens([report])) * scale
    : legacy ? legacyInput + legacyOutput + estimateTokens(messages.slice(messages.lastIndexOf(legacy) + 1))
    : measure || prompt ? raw * scale : contextTokens(messages)));
  const contextWindow = planMode && measure?.plan ? measure.window || window : window;
  const lastRequest = measure ? { provider: report.provider, model: report.model, input: measure.input, output: measure.output }
    : legacy ? { provider, model, input: legacyInput, output: legacyOutput } : null;
  return {
    tokens,
    contextWindow,
    percent: contextWindow ? tokens / contextWindow * 100 : null,
    estimated: !latest || !(planMode && measure?.plan ? measure.windowKnown : windowKnown),
    windowEstimated: !(planMode && measure?.plan ? measure.windowKnown : windowKnown),
    breakdown: allocate(weights, tokens),
    lastRequest,
  };
}
