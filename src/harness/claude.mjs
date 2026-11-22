// Claude Code as an ORBIX agent: one `claude -p` process per conversation, stream-json on stdin and stdout, with
// the control protocol for permissions (--permission-prompt-tool stdio), model changes and interrupts. Claude Code
// keeps its own agent loop, tools, login and history (~/.claude/projects); ORBIX shows the work and answers its
// permission questions with its own approval cards, so Supervised, Auto edits and Full access work as they do for ORBIX.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { LineProcess } from './lines.mjs';
import { fromClaude, resultText } from './tools.mjs';

export const CLAUDE_MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet (latest)', reasoning: true },
  { id: 'opus', name: 'Claude Opus (latest)', reasoning: true },
  { id: 'haiku', name: 'Claude Haiku (latest)', reasoning: true },
];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** ORBIX approvals → Claude Code permission mode. Full access still answers each question itself (see proc). */
const MODE = { ask: 'default', edits: 'acceptEdits', safe: 'acceptEdits', auto: 'acceptEdits' };

export class ClaudeDriver extends EventEmitter {
  constructor({ backend, bin, cwd, approvals, noCoAuthor = false, noSubagents = false }) {
    super();
    this.backend = backend;
    this.bin = bin;
    this.cwd = cwd;
    this.approvals = approvals;
    this.noCoAuthor = noCoAuthor;
    this.noSubagents = noSubagents; // Settings → Agents: Claude Code's own helper agents (the Task tool) off
    this.lp = null;
    this.ctl = new Map(); // control request id → resolve
    this.seq = 0;
    this.blocks = new Map(); // stream index → { kind, key, toolId }
    this.msgSeq = 0;
    this.started = new Set(); // tool ids already announced
    this.nativeId = '';
    this.model = '';
    this.busy = false;
    this.ask = async () => 'deny';
  }

  /** Start (or resume `resume`, a Claude session id) and wait until Claude Code says it is ready. */
  async start({ model, resume, effort }) {
    this.nativeId = resume || crypto.randomUUID();
    const argv = [this.bin, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', MODE[this.approvals] || 'default', '--disallowedTools', ['AskUserQuestion', ...(this.noSubagents ? ['Task', 'Agent'] : [])].join(',')];
    // Settings → Preferences → Git: Claude Code's own settings turn its commit and PR credit lines off (both the
    // current `attribution` and the older `includeCoAuthoredBy`).
    if (this.noCoAuthor) argv.push('--settings', JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } }));
    if (model) argv.push('--model', model);
    if (resume) argv.push('--resume', resume);
    else argv.push('--session-id', this.nativeId);
    this.lp = new LineProcess(this.backend.spawn(argv, { cwd: this.cwd, env: { DISABLE_AUTOUPDATER: '1' }, quiet: true }));
    this.lp.on('message', (m) => this._take(m));
    this.lp.on('exit', (code) => {
      for (const r of this.ctl.values()) r({ error: 'Claude Code stopped' });
      this.ctl.clear();
      if (this.busy) this._end('error', this.lp.why() || `Claude Code stopped (exit ${code})`);
      this.emit('exit', { code, why: this.lp.why() });
    });
    const init = await this._control({ subtype: 'initialize' }, 60000);
    if (init?.error) throw new Error(`Claude Code did not start: ${init.error}${this.lp.why() ? `\n${this.lp.why()}` : ''}`);
    this.commands = (init?.commands || []).map((c) => ({ name: c.name, description: c.description || '', source: 'agent' }));
    if (effort) await this.setEffort(effort);
    return { nativeId: this.nativeId, commands: this.commands };
  }

  _control(request, timeout = 20000) {
    const request_id = `orbix-${++this.seq}`;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.ctl.delete(request_id);
        resolve({ error: 'no answer' });
      }, timeout);
      this.ctl.set(request_id, (v) => (clearTimeout(t), resolve(v)));
      if (!this.lp.send({ type: 'control_request', request_id, request })) {
        clearTimeout(t);
        this.ctl.delete(request_id);
        resolve({ error: this.lp.why() || 'Claude Code is not running' });
      }
    });
  }

  prompt(text, images = []) {
    this.busy = true;
    this.blocks.clear();
    const content = [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType || 'image/png', data: i.data } }))];
    if (!this.lp?.send({ type: 'user', session_id: this.nativeId, parent_tool_use_id: null, message: { role: 'user', content } })) {
      this._end('error', this.lp?.why() || 'Claude Code is not running');
    }
  }

  async interrupt() {
    if (!this.busy) return;
    await this._control({ subtype: 'interrupt' }, 8000);
  }

  async setModel(model) {
    this.model = model;
    const r = await this._control({ subtype: 'set_model', model });
    if (r?.error) throw new Error(`Claude Code could not switch model: ${r.error}`);
  }

  async setEffort(level) {
    // Older Claude Code versions do not know this request; the session then keeps its default effort.
    await this._control({ subtype: 'apply_flag_settings', settings: { effortLevel: level } }, 8000);
  }

  async setMode(approvals) {
    this.approvals = approvals;
    await this._control({ subtype: 'set_permission_mode', mode: MODE[approvals] || 'default' }, 8000);
  }

  close() {
    return this.lp?.close(2000);
  }

  _end(status, error) {
    if (!this.busy) return;
    this.busy = false;
    this.emit('turn_end', { status, error });
  }

  async _take(m) {
    switch (m.type) {
      case 'control_response': {
        const r = m.response || {};
        const done = this.ctl.get(r.request_id);
        if (!done) return;
        this.ctl.delete(r.request_id);
        done(r.subtype === 'success' ? r.response || {} : { error: r.error || 'failed' });
        return;
      }
      case 'control_request':
        return this._answer(m);
      case 'system':
        if (m.subtype === 'init') {
          if (m.session_id) this.nativeId = m.session_id;
          if (m.model) this.model = m.model;
          this.emit('native', { id: this.nativeId, model: this.model });
        } else if (m.subtype === 'compact_boundary') this.emit('notice', { level: 'info', message: 'Claude Code compacted the conversation.' });
        return;
      case 'stream_event':
        if (m.parent_tool_use_id) return; // a subagent's own steps stay inside its Task step
        return this._stream(m.event || {});
      case 'assistant':
        if (m.parent_tool_use_id) return;
        for (const b of m.message?.content || []) {
          if (b.type !== 'tool_use') continue;
          const t = fromClaude(b.name, b.input);
          if (!this.started.has(b.id)) {
            this.started.add(b.id);
            this.emit('tool_start', { id: b.id, ...t });
          } else this.emit('tool_args', { id: b.id, ...t });
        }
        if (m.message?.usage) this.emit('step_usage', m.message.usage);
        return;
      case 'user':
        if (m.parent_tool_use_id) return;
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (b.type === 'tool_result') this.emit('tool_end', { id: b.tool_use_id, output: resultText(b.content), isError: !!b.is_error });
        }
        return;
      case 'rate_limit_event':
        this.emit('limits', m.rate_limit_info || {});
        return;
      case 'result': {
        const u = m.usage || {};
        this.emit('usage', { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, costUsd: Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : undefined });
        if (m.session_id) this.nativeId = m.session_id;
        const failed = m.is_error || (m.subtype && m.subtype !== 'success');
        const aborted = /interrupt|abort|cancel/i.test(`${m.subtype || ''} ${m.stop_reason || ''}`);
        this._end(aborted ? 'aborted' : failed ? 'error' : 'completed', failed && !aborted ? (typeof m.result === 'string' && m.result) || m.error || m.subtype : undefined);
        return;
      }
      default:
    }
  }

  _stream(e) {
    switch (e.type) {
      case 'message_start':
        this.msgSeq++;
        return;
      case 'content_block_start': {
        const b = e.content_block || {};
        const key = `${this.msgSeq}:${e.index}`;
        if (b.type === 'tool_use') {
          this.blocks.set(e.index, { kind: 'tool', key, toolId: b.id });
          if (!this.started.has(b.id)) {
            this.started.add(b.id);
            this.emit('tool_start', { id: b.id, ...fromClaude(b.name, {}) });
          }
        } else this.blocks.set(e.index, { kind: b.type === 'thinking' || b.type === 'redacted_thinking' ? 'thinking' : 'text', key });
        return;
      }
      case 'content_block_delta': {
        const blk = this.blocks.get(e.index);
        const d = e.delta || {};
        if (d.type === 'text_delta' && d.text) this.emit('text', { key: blk?.key || `${this.msgSeq}:${e.index}`, delta: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) this.emit('thinking', { key: blk?.key || `${this.msgSeq}:${e.index}`, delta: d.thinking });
        return;
      }
      default:
    }
  }

  /** A question from Claude Code: may it use this tool? Anything else it asks is declined. */
  async _answer(m) {
    const req = m.request || {};
    const reply = (response) => this.lp.send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
    if (req.subtype !== 'can_use_tool') {
      this.lp.send({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `ORBIX does not handle ${req.subtype}` } });
      return;
    }
    const t = fromClaude(req.tool_name, req.input);
    const ans = await this.ask({ id: req.tool_use_id || m.request_id, raw: req.tool_name, ...t, input: req.input }).catch(() => 'deny');
    if (ans === 'allow' || ans === 'allow_session') reply({ behavior: 'allow', updatedInput: req.input || {} });
    else reply({ behavior: 'deny', message: 'The user declined this step in ORBIX. Do not try it again in another way; ask what they want instead.' });
  }
}
