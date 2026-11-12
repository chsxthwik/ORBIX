// Context compaction. The full history stays in the session (and on screen); a `compactionSummary` marker is
// inserted where the cut was made. What the model sees is: the summary, then every message after the marker.
// The session file records { type: 'compaction', summary, keptCount } so a resumed session rebuilds the same context.
import fs from 'node:fs';
import { collectTurn } from './assemble.mjs';

const AUTO_COMPACT_RATIO = 0.8;

/**
 * Context tokens above which the next request compacts first. The reply's max_tokens is reserved too: many servers
 * reject a request whose prompt plus max_tokens exceeds the window (at most half the window is reserved).
 */
export const compactLimit = (contextWindow, reserve = 0) => Math.min(contextWindow * AUTO_COMPACT_RATIO, contextWindow - Math.min(Math.max(0, reserve || 0), contextWindow / 2));
const IMAGE_TOKENS = 1600;

const textOf = (m) => (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]).map((c) => (c.type === 'text' ? c.text : c.type === 'thinking' ? c.thinking : c.type === 'toolCall' ? `${c.name} ${JSON.stringify(c.arguments || {})}` : '')).join('\n');

export function estimateTokens(messages) {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (m.role === 'compactionSummary') chars += (m.summary || '').length;
    else {
      chars += textOf(m).length;
      for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'image') images++;
      for (const a of m.attachments || []) chars += (a.text || '').length;
    }
  }
  return Math.ceil(chars / 3.6) + images * IMAGE_TOKENS;
}

/** True when a provider error says the request was larger than the model's context window. */
export const isOverflow = (msg) => /context|too long|too many tokens|maximum.*tokens|token limit|prompt is too long|reduce the length/i.test(msg || '') && /exceed|maximum|limit|too long|too large|reduce/i.test(msg || '');

export const lastMarker = (messages) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'compactionSummary') return i;
  return -1;
};

export const summaryText = (summary) => `<conversation-summary>\nThe earlier part of this conversation was compacted to save context. This summary replaces it:\n\n${summary}\n</conversation-summary>`;

const attachmentsText = (atts) => atts.map((a) => `<file path="${a.path}"${a.truncated ? ' truncated="true"' : ''}>\n${a.text}\n</file>`).join('\n\n');

/** The messages to send to the provider: summary + messages after the last marker, with @file attachments inlined. */
export function contextMessages(messages) {
  const start = lastMarker(messages);
  const out = [];
  if (start >= 0) {
    // A compaction in the middle of a long run can summarize the user's request itself; the model then gets it back
    // word for word after the summary, so an exact instruction ("do not touch file Y") is never only paraphrased.
    let text = summaryText(messages[start].summary);
    if (!messages.slice(start + 1).some((m) => m.role === 'user')) {
      const ask = messages.slice(0, start).findLast((m) => m.role === 'user');
      const said = (ask?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (said) text += `\n\n<latest-user-message>\n${said.length > 8000 ? `${said.slice(0, 8000)}\n[… cut at 8,000 characters]` : said}\n</latest-user-message>`;
    }
    out.push({ role: 'user', content: [{ type: 'text', text }], timestamp: messages[start].timestamp });
  }
  // A reply that was stopped or failed mid-stream can hold tool calls that never ran; providers reject a tool call
  // without a result, so those calls are left out.
  const answered = new Set();
  for (let i = start + 1; i < messages.length; i++) if (messages[i].role === 'toolResult') answered.add(messages[i].toolCallId);
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'compactionSummary' || m.role?.startsWith?.('_') || m.discard) continue;
    // Engine notes meant for the model (e.g. "continue where the reply was cut off") travel as user text.
    if (m.role === 'custom') {
      if (m.forModel) out.push({ role: 'user', content: m.content, timestamp: m.timestamp });
      continue;
    }
    let mm = m;
    if (m.role === 'assistant' && m.content?.some?.((c) => c.type === 'toolCall' && !answered.has(c.id))) mm = { ...m, content: m.content.filter((c) => c.type !== 'toolCall' || answered.has(c.id)) };
    if (m.role === 'user' && m.attachments?.length) mm = { ...m, content: [...(m.content || []), { type: 'text', text: attachmentsText(m.attachments) }] };
    const prev = out[out.length - 1];
    if (mm.role === 'user' && prev?.role === 'user' && i === start + 1) out[out.length - 1] = { ...mm, content: [...prev.content, ...(mm.content || [])] };
    else out.push(mm);
  }
  return out;
}

/**
 * How many real tokens one estimated token stands for in this context (>= 1). Reported usage also counts the
 * system prompt and tool schemas, so cutting by the plain estimate would keep far too much.
 */
export function tokenScale(messages) {
  const est = estimateTokens(contextMessages(messages));
  const real = contextTokens(messages);
  return est > 0 ? Math.max(1, real / est) : 1;
}

/** Tokens the next request would carry: the last reply's reported usage when known, else an estimate. */
export function contextTokens(messages) {
  const start = lastMarker(messages);
  for (let i = messages.length - 1; i > start; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.usage && m.usage.input + m.usage.cacheRead + m.usage.cacheWrite > 0) {
      return m.usage.input + m.usage.cacheRead + m.usage.cacheWrite + m.usage.output + estimateTokens(messages.slice(i + 1));
    }
  }
  return estimateTokens(contextMessages(messages));
}

/**
 * Where to cut: keep roughly `keepTokens` of the most recent messages. A cut is only made right before a user or
 * assistant message (never between a tool call and its result) and always keeps the last user/assistant message.
 * Returns -1 when there is nothing old enough to summarize.
 */
export function findCut(messages, keepTokens) {
  const start = lastMarker(messages) + 1;
  let maxCut = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i].role === 'user' || messages[i].role === 'assistant') {
      maxCut = i;
      break;
    }
  }
  if (maxCut <= start) return -1;
  let acc = 0;
  let i = messages.length - 1;
  for (; i > start; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc >= keepTokens) break;
  }
  let cut = Math.max(i, start + 1);
  while (cut < maxCut && messages[cut].role !== 'user' && messages[cut].role !== 'assistant') cut++;
  cut = Math.min(cut, maxCut);
  // Prefer starting the kept part at a user turn when one is close by.
  for (let j = cut; j <= maxCut && j < cut + 8; j++) if (messages[j].role === 'user') return j;
  return cut > start ? cut : -1;
}

/** A plain-text transcript of messages for the summarizer, with long tool output clipped. */
export function transcript(messages, maxChars) {
  const lines = [];
  // Start and end are kept: tool output ends with the exit code, the last error or the summary line.
  const clipTo = (s, n) => {
    if (s.length <= n) return s;
    const tail = Math.floor(n / 3);
    return `${s.slice(0, n - tail)} … [${s.length - n} characters omitted] … ${s.slice(-tail)}`;
  };
  for (const m of messages) {
    if (m.role === 'compactionSummary') lines.push(`[Earlier summary]\n${m.summary}`);
    else if (m.role === 'user') {
      lines.push(`USER: ${clipTo(textOf(m), 8000)}`);
      for (const a of m.attachments || []) lines.push(`(attached file ${a.path}: ${clipTo(a.text, 1500)})`);
    } else if (m.role === 'assistant') {
      for (const c of m.content || []) {
        if (c.type === 'text' && c.text.trim()) lines.push(`ASSISTANT: ${clipTo(c.text, 6000)}`);
        else if (c.type === 'toolCall') lines.push(`ASSISTANT CALLED ${c.name}: ${clipTo(JSON.stringify(c.arguments || {}), 1200)}`);
      }
      if (m.stopReason === 'error' && m.errorMessage) lines.push(`(error: ${m.errorMessage})`);
    } else if (m.role === 'toolResult') lines.push(`RESULT of ${m.toolName}${m.isError ? ' (error)' : ''}: ${clipTo(textOf(m), 1500)}`);
  }
  let out = lines.join('\n\n');
  if (out.length > maxChars) out = '[…the oldest part is omitted…]\n\n' + out.slice(out.length - maxChars);
  return out;
}

const SUMMARY_SYSTEM = 'You compress coding-agent conversations into a precise working summary that lets the agent continue the task. Write only the summary, no preamble.';

const SUMMARY_PROMPT = (focus) => `Summarize the conversation above for the agent that will continue it. Keep everything needed to carry on without re-reading files:

1. **Goal**: what the user asked for, including constraints and preferences they stated.
2. **Done so far**: changes made (file paths, functions), commands run and their important results.
3. **Key facts**: file paths, names, decisions, errors seen and how they were handled, anything the user approved or refused.
4. **Current state**: what is in progress right now and what is left to do, in order.

Be concrete and complete but compact (bullets, no filler). Quote exact identifiers and paths.${focus ? `\n\nThe user asked to focus the summary on: ${focus}` : ''}`;

/** Ask the model for a summary of `older` (messages before the cut). Returns { summary, usage }. */
export async function summarize({ stream, older, focus, contextWindow, signal, onRetry }) {
  const budgetChars = Math.max(20000, Math.floor((contextWindow || 128000) * 0.6 * 3.6));
  const body = transcript(older, budgetChars);
  const messages = [{ role: 'user', content: [{ type: 'text', text: `<conversation>\n${body}\n</conversation>\n\n${SUMMARY_PROMPT(focus)}` }], timestamp: Date.now() }];
  const msg = await collectTurn(stream({ system: SUMMARY_SYSTEM, messages, tools: [], signal, maxTokens: 8192 }), { retry: onRetry });
  const summary = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!summary) throw new Error('The model returned an empty summary');
  return { summary, usage: msg.usage };
}

/**
 * Read a saved agent session file in order and rebuild the message list including compaction markers and rewinds
 * (regenerate / edit), plus engine settings recorded along the way (thinking level, plan mode, model).
 */
export function rebuildSession(file) {
  const messages = [];
  // droppedUsage: tokens and cost of replies that were later regenerated or edited away (still spent).
  const extras = { thinkingLevel: null, planMode: false, model: null, provider: null, roles: null, droppedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { messages, extras };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'message' && o.message) messages.push(o.message);
    else if (o.type === 'compaction' && typeof o.summary === 'string') {
      const at = Math.max(0, messages.length - Math.max(0, o.keptCount | 0));
      messages.splice(at, 0, { role: 'compactionSummary', summary: o.summary, tokensBefore: o.tokensBefore, timestamp: o.timestamp || Date.now(), ...(o.usage ? { usage: o.usage } : {}), ...(Number.isFinite(o.cost) ? { cost: o.cost } : {}) });
    } else if (o.type === 'rewind' && Number.isInteger(o.count) && o.count >= 0) {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) extras.droppedUsage[k] += Number(o.dropped?.[k]) || 0;
      messages.length = Math.min(messages.length, o.count);
    } else if (o.type === 'thinking') extras.thinkingLevel = o.level;
    else if (o.type === 'plan') extras.planMode = !!o.on;
    else if (o.type === 'roles') extras.roles = { fast: String(o.fast || ''), plan: String(o.plan || '') };
    else if (o.type === 'model') {
      extras.model = o.model;
      extras.provider = o.provider;
    }
  }
  return { messages, extras };
}
