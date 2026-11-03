// Turns the normalised provider stream events (anthropic.mjs / openai.mjs) into one assistant message.
// Shared by the main agent loop (which shows it live) and by subagents and compaction (which only need the result).

/** Provider stop reasons -> the internal vocabulary. */
const STOP_MAP = { end_turn: 'stop', tool_use: 'toolUse', max_tokens: 'length', stop_sequence: 'stop', refusal: 'stop', pause_turn: 'stop' };

const closers = (stack) => stack.map((c) => (c === '{' ? '}' : ']')).reverse().join('');

/**
 * Best-effort parse of JSON that is still streaming in ('{"path":"a.js","content":"line 1\\nli'), so the UI can
 * show tool arguments as they are written. Returns an object, or undefined when nothing usable is there yet.
 */
export function parsePartialJson(s) {
  if (!s || !s.trim()) return undefined;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {}
  const stack = [];
  let inStr = false;
  let esc = false;
  let isKey = false;
  let expectKey = false;
  let safe = -1;
  let safeStack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        if (!isKey) {
          safe = i + 1;
          safeStack = stack.slice();
        }
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      isKey = stack[stack.length - 1] === '{' && expectKey;
    } else if (c === '{' || c === '[') {
      stack.push(c);
      expectKey = c === '{';
      safe = i + 1;
      safeStack = stack.slice();
    } else if (c === '}' || c === ']') {
      stack.pop();
      expectKey = false;
      safe = i + 1;
      safeStack = stack.slice();
    } else if (c === ',') expectKey = stack[stack.length - 1] === '{';
    else if (c === ':') expectKey = false;
  }
  const attempt = (text) => {
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  let first;
  if (inStr && !isKey) {
    let base = esc ? s.slice(0, -1) : s;
    base = base.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    first = attempt(base + '"' + closers(stack));
  } else if (!inStr) first = attempt(s.replace(/[\s,:]+$/, '') + closers(stack));
  if (first) return first;
  return safe > 0 ? attempt(s.slice(0, safe).replace(/[\s,]+$/, '') + closers(safeStack)) : undefined;
}

/** Accumulates stream events into `msg` ({ content: [], usage, stopReason }). */
export class TurnAssembler {
  constructor(msg) {
    this.msg = msg;
    this.pos = new Map(); // stream block index -> content position
    this.json = new Map(); // tool block index -> JSON text so far
    this.open = new Set(); // tool block indexes not closed yet
    this.dirty = new Set(); // tool block indexes with unparsed JSON
  }

  /** Apply one event. Returns { kind, index, delta } for a live view (kind as in OMP's assistantMessageEvent), or null. */
  push(ev) {
    const msg = this.msg;
    switch (ev.type) {
      case 'text':
      case 'thinking': {
        let p = this.pos.get(ev.index);
        if (p == null || msg.content[p].type !== ev.type) {
          p = msg.content.push(ev.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }) - 1;
          this.pos.set(ev.index, p);
        }
        if (ev.type === 'text') msg.content[p].text += ev.text;
        else msg.content[p].thinking += ev.text;
        return { kind: `${ev.type}_delta`, index: p, delta: ev.text };
      }
      case 'signature': {
        // The signature belongs to whatever block sits at that index (thinking or tool call). A redacted
        // thinking block has no text at all, so it is created here; empty thinking blocks are kept.
        let p = this.pos.get(ev.index);
        if (p == null) {
          p = msg.content.push({ type: 'thinking', thinking: '' }) - 1;
          this.pos.set(ev.index, p);
        }
        msg.content[p].thinkingSignature = ev.signature;
        if (ev.redacted) msg.content[p].redacted = true;
        return null;
      }
      case 'tool_start': {
        const p = msg.content.push({ type: 'toolCall', id: ev.id, name: ev.name, arguments: {} }) - 1;
        this.pos.set(ev.index, p);
        this.json.set(ev.index, '');
        this.open.add(ev.index);
        return { kind: 'toolcall_start', index: p, delta: '' };
      }
      case 'tool_json': {
        if (!this.json.has(ev.index)) return null;
        this.json.set(ev.index, this.json.get(ev.index) + ev.json);
        this.dirty.add(ev.index);
        return { kind: 'toolcall_delta', index: this.pos.get(ev.index), delta: ev.json };
      }
      case 'block_stop': {
        if (!this.open.has(ev.index)) return null;
        this._close(ev.index);
        return { kind: 'toolcall_end', index: this.pos.get(ev.index), delta: '' };
      }
      case 'usage': {
        const u = msg.usage;
        if (Number.isFinite(ev.costUsd)) u.costUsd = ev.costUsd;
        if (ev.outputIsTotal) {
          if (Number.isFinite(ev.output)) u.output = ev.output;
          for (const k of ['input', 'cacheRead', 'cacheWrite']) if (Number.isFinite(ev[k])) u[k] = ev[k];
        } else {
          u.input = ev.input ?? u.input;
          u.output = ev.output ?? u.output;
          u.cacheRead = ev.cacheRead ?? 0;
          u.cacheWrite = ev.cacheWrite ?? 0;
        }
        return null;
      }
      case 'stop':
        msg.stopReason = STOP_MAP[ev.reason] || 'stop';
        if (ev.reason === 'refusal') msg.refusal = true;
        return null;
      default:
        return null;
    }
  }

  _close(index) {
    this.open.delete(index);
    this.dirty.delete(index);
    const block = this.msg.content[this.pos.get(index)];
    const buf = this.json.get(index);
    if (!buf.trim()) {
      block.arguments = {};
      return;
    }
    try {
      const v = JSON.parse(buf);
      if (v && typeof v === 'object' && !Array.isArray(v)) block.arguments = v;
      else throw new Error('not an object');
    } catch {
      // Keep what could be read (the UI shows it; the model sees what it sent) and flag the call so it is not run.
      block.arguments = parsePartialJson(buf) || {};
      block.invalidArguments = true;
    }
  }

  /** Parse the tool arguments that streamed in since the last call (done only when a live snapshot is sent). */
  refreshPartial() {
    for (const index of this.dirty) {
      const v = parsePartialJson(this.json.get(index));
      if (v) this.msg.content[this.pos.get(index)].arguments = v;
    }
    this.dirty.clear();
  }

  /** End of the stream: tool calls whose block never closed (some servers skip block_stop) get their arguments. */
  finish() {
    for (const index of [...this.open]) this._close(index);
    return this.msg;
  }
}

/** Run one provider stream to completion and return an assistant message. Calls `on.retry`/`on.text` as it goes. */
export async function collectTurn(stream, on = {}) {
  const msg = { role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop' };
  const asm = new TurnAssembler(msg);
  for await (const ev of stream) {
    if (ev.type === 'retry') {
      on.retry?.(ev);
      continue;
    }
    const r = asm.push(ev);
    if (r?.kind === 'text_delta') on.text?.(ev.text);
  }
  return asm.finish();
}
