// A conversation run by another agent CLI (Claude Code, Codex, OpenCode, any ACP agent). It speaks to the server and
// the UI exactly like AgentProc (requests in, the same events out) so every ORBIX view works with it: the live work
// row, steps, approvals, the sidebar, search, export. ORBIX saves its own copy of the conversation (with the agent's
// session id), and reopening it resumes the agent's native session.
import { EventEmitter } from 'node:events';
import { clip, makeTitle, uid } from '../util.mjs';
import { createSession, appendEntry, closeSession, loadSession, repairTail } from '../engine/store.mjs';
import { promptImages, promptAttachments, readMentions } from '../engine/context.mjs';
import { createTools } from '../engine/tools.mjs';
import { destructiveReason, catastrophicReason, readOnlyCommand } from '../engine/policy.mjs';
import { writeExport } from '../engine/export.mjs';
import { zeroUsage } from '../engine/proc-usage.mjs';
import { ClaudeDriver } from './claude.mjs';
import { CodexDriver } from './codex.mjs';
import { AcpDriver } from './acp.mjs';

const MAX_RESULT = 60000;
const EDITS = new Set(['edit', 'write', 'patch']);

export class HarnessProc extends EventEmitter {
  constructor({ id, backend, workspace, resume, model, noSession, config, worktree, agent, registry }) {
    super();
    this.id = id;
    this.backend = backend;
    this.workspace = workspace;
    this.worktree = worktree || null;
    this.worktreeState = null;
    this.opts = { resume, model, noSession };
    this.config = config;
    this.agent = agent; // { id, name, kind, ... } from the registry
    this.registry = registry;
    this.provider = agent.id;
    this.model = model && model !== 'default' ? model : '';
    this.thinkingLevel = '';
    this.exited = false;
    this.streaming = false;
    this.compacting = false;
    this.stderrTail = [];
    this.startedAt = Date.now();
    this.cache = { commands: [] };
    this.messages = [];
    this.title = '';
    this.titleBy = '';
    this.session = null;
    this.sessionId = null;
    this.nativeId = '';
    this.planMode = false;
    this.allowAlways = new Set();
    this.pendingAsk = new Map();
    this.askSeq = 0;
    this.queue = { steer: [], followUp: [] };
    this.usage = zeroUsage();
    this.cost = 0;
    this.costKnown = false;
    this.run = null;
    this.runInfo = null;
    this.limits = null;
    this.driver = null;
    this.bashCtl = null;
    this.consoleTools = createTools({ backend, cwd: workspace, getSignal: () => this.bashCtl?.signal });
  }

  _emit(ev) {
    this.emit('event', ev);
  }

  async start() {
    if (this.opts.resume) {
      repairTail(this.opts.resume);
      const s = loadSession(this.opts.resume);
      if (!s.header) throw new Error('That saved conversation could not be read');
      this.messages = s.messages;
      this.title = s.title;
      this.titleBy = s.titleBy || '';
      this.session = { id: s.header.id, file: this.opts.resume };
      this.sessionId = s.header.id;
      this.nativeId = s.native || '';
      this.handoff = !!s.handoff;
      if (s.header.worktree) this.worktree = s.header.worktree;
      this.worktreeState = s.worktreeState || null;
      if (!this.opts.model && s.header.model) this.model = s.header.model;
      for (const m of this.messages) if (m.role === 'assistant' && m.usage) this._addUsage(m.usage);
    }
    await this._driver();
    return this;
  }

  /** Start the agent CLI (again, after it stopped), resuming its own session when there is one. */
  async _driver() {
    const a = this.agent;
    const approvals = this.config.data.approvals;
    const cwd = this.workspace;
    let d;
    if (a.kind === 'claude') d = new ClaudeDriver({ backend: this.backend, bin: (await this.registry.argv(a))[0], cwd, approvals, noCoAuthor: this.config.data.noCoAuthor === true, noSubagents: this.config.data.claudeNoSubagents === true });
    else if (a.kind === 'codex') d = new CodexDriver({ backend: this.backend, bin: (await this.registry.argv(a))[0], cwd, approvals });
    else {
      // OpenCode asks through ACP only for what its config says "ask": commands always (ORBIX decides, Full access included,
      // so a destructive one still asks), file edits unless Auto edits or Full access allow them.
      const env = a.id === 'agent-opencode' ? { ...a.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, permission: { edit: approvals === 'ask' ? 'ask' : 'allow', bash: 'ask', webfetch: approvals === 'auto' ? 'allow' : 'ask' } }) } : a.env;
      d = new AcpDriver({ backend: this.backend, argv: await this.registry.argv(a), cwd, approvals, env, name: a.name });
    }
    d.ask = (req) => this._approve(req);
    this._wire(d);
    this.driver = d;
    const r = await d.start({ model: this.model, resume: this.nativeId || undefined, effort: this.thinkingLevel || undefined });
    this._setNative(r.nativeId);
    if (!this.model && r.model) this.model = r.model;
    this.cache.commands = r.commands || [];
    this._emit({ type: 'available_commands_update', commands: this.cache.commands });
  }

  _setNative(id) {
    if (!id || id === this.nativeId) return;
    this.nativeId = id;
    if (this.session && !this.opts.noSession) appendEntry(this.session.file, { type: 'native', id });
  }

  _wire(d) {
    d.on('native', ({ id, model }) => {
      this._setNative(id);
      if (model && !this.model) this.model = model;
    });
    d.on('text', ({ key, delta }) => this._delta('text', key, delta));
    d.on('thinking', ({ key, delta }) => this._delta('thinking', key, delta));
    d.on('text_final', ({ key, text }) => {
      if (!this.blocks?.has(`text:${key}`)) this._delta('text', key, text);
    });
    d.on('tool_start', (t) => this._toolStart(t));
    d.on('tool_args', (t) => this._toolArgs(t));
    d.on('tool_update', ({ id, output }) => {
      const t = this.tools?.get(id);
      if (t) this._emit({ type: 'tool_execution_update', toolCallId: id, toolName: t.name, args: t.arguments, partialResult: { content: [{ type: 'text', text: clip(output, MAX_RESULT) }], details: {} } });
    });
    d.on('tool_end', (t) => this._toolEnd(t));
    d.on('usage', (u) => this._turnUsage(u));
    d.on('limits', (l) => {
      this.limits = { ...l, at: Date.now() };
      this._emit({ type: 'agent_limits', agent: this.agent.id, limits: this.limits });
    });
    d.on('commands', (c) => {
      this.cache.commands = c;
      this._emit({ type: 'available_commands_update', commands: c });
    });
    d.on('plan', (entries) => {
      this.todoPhases = [{ name: 'Plan', items: entries.map((e) => ({ text: e.text, status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'doing' : 'todo' })) }];
      this._emit({ type: 'todo_update', phases: this.todoPhases });
    });
    d.on('notice', (n) => this._emit({ type: 'notice', level: n.level || 'info', message: n.message }));
    d.on('turn_end', (e) => this._turnEnd(e));
    d.on('exit', ({ code, why }) => {
      if (this.driver !== d) return;
      this.driver = null;
      if (this.exited) return;
      for (const l of String(why || '').split('\n')) if (l.trim()) this.stderrTail.push(l);
      this.stderrTail = this.stderrTail.slice(-30);
      this._emit({ type: 'notice', level: 'warn', message: `${this.agent.name} stopped${code ? ` (exit ${code})` : ''}. It starts again with your next message.${why ? `\n${clip(why, 600)}` : ''}` });
    });
  }

  // ---- The assistant message being written --------------------------------------------------------------------

  _cur() {
    if (!this.cur) {
      this.cur = { role: 'assistant', id: uid('a'), content: [], provider: this.agent.id, model: this.model || 'default', usage: { ...zeroUsage(), totalTokens: 0 }, stopReason: 'stop', timestamp: Date.now() };
      this.blocks = new Map();
      this._emit({ type: 'message_start', message: structuredClone(this.cur) });
    }
    return this.cur;
  }

  _update(kind, index, delta = '') {
    const now = Date.now();
    if (/_delta$/.test(kind) && now - (this.lastUpdate || 0) < 30) return;
    this.lastUpdate = now;
    this._emit({ type: 'message_update', message: structuredClone(this.cur), assistantMessageEvent: { type: kind, contentIndex: index, delta } });
  }

  _delta(type, key, delta) {
    if (!delta) return;
    const msg = this._cur();
    const k = `${type}:${key}`;
    let i = this.blocks.get(k);
    if (i == null) {
      i = msg.content.push(type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' }) - 1;
      this.blocks.set(k, i);
    }
    if (type === 'text') msg.content[i].text += delta;
    else msg.content[i].thinking += delta;
    this._update(`${type}_delta`, i, delta);
  }

  _toolStart({ id, name, arguments: args, intent }) {
    if (!id || this.tools.has(id)) return;
    const msg = this._cur();
    const call = { type: 'toolCall', id, name, arguments: args || {}, ...(intent ? { intent } : {}) };
    const i = msg.content.push(call) - 1;
    this.tools.set(id, { name, arguments: call.arguments, intent, msg, index: i });
    if (this.run) this.run.toolCalls++;
    this._update('toolcall_start', i);
    this._update('toolcall_end', i);
    this._emit({ type: 'tool_execution_start', toolCallId: id, toolName: name, args: call.arguments, intent });
  }

  _toolArgs({ id, name, arguments: args, intent }) {
    const t = this.tools.get(id);
    if (!t) return this._toolStart({ id, name, arguments: args, intent });
    t.name = name || t.name;
    t.arguments = args || t.arguments;
    const block = t.msg.content[t.index];
    if (block) Object.assign(block, { name: t.name, arguments: t.arguments, ...(intent ? { intent } : {}) });
    if (t.msg === this.cur) this._update('toolcall_end', t.index);
  }

  _toolEnd({ id, output, isError, exitCode }) {
    let t = this.tools.get(id);
    if (!t) {
      this._toolStart({ id, name: 'tool', arguments: {} });
      t = this.tools.get(id);
    }
    if (t.done) return;
    t.done = true;
    this._finishCur(); // the step's result comes after the message that asked for it
    const content = [{ type: 'text', text: clip(String(output ?? ''), MAX_RESULT) }];
    const details = { agent: this.agent.id, ...(exitCode != null ? { exitCode } : {}) };
    const res = { role: 'toolResult', toolCallId: id, toolName: t.name, content, details, isError: !!isError, timestamp: Date.now() };
    this.messages.push(res);
    this._persist(res);
    this._emit({ type: 'tool_execution_end', toolCallId: id, toolName: t.name, result: { content, details }, isError: !!isError });
    this._emit({ type: 'message_start', message: res });
    this._emit({ type: 'message_end', message: res });
  }

  _finishCur(stopReason = 'stop', errorMessage) {
    const msg = this.cur;
    if (!msg) return null;
    this.cur = null;
    msg.stopReason = msg.content.some((c) => c.type === 'toolCall') && stopReason === 'stop' ? 'toolUse' : stopReason;
    if (errorMessage) msg.errorMessage = errorMessage;
    msg.doneAt = Date.now();
    this.messages.push(msg);
    this._persist(msg);
    this._emit({ type: 'message_end', message: structuredClone(msg) });
    return msg;
  }

  _addUsage(u) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) this.usage[k] += u[k] || 0;
    const c = u.cost?.total ?? u.costUsd;
    if (Number.isFinite(c)) {
      this.cost += c;
      this.costKnown = true;
    }
  }

  _turnUsage(u) {
    if (!this.run) return;
    const r = this.run.usage;
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) r[k] += u[k] || 0;
    if (Number.isFinite(u.costUsd)) r.costUsd = (r.costUsd || 0) + u.costUsd;
    if (u.contextWindow) this.contextWindow = u.contextWindow;
  }

  // ---- Turns ----------------------------------------------------------------------------------------------------

  _persist(message) {
    if (this.opts.noSession) return;
    this._ensureSession();
    appendEntry(this.session.file, { type: 'message', message });
  }

  _ensureSession() {
    if (this.session || this.opts.noSession) return;
    this.session = createSession({ cwd: this.workspace, keyPath: this.backend.keyPath(this.workspace), model: this.model, provider: this.agent.id, worktree: this.worktree || undefined, engine: this.agent.id });
    this.sessionId = this.session.id;
    if (this.nativeId) appendEntry(this.session.file, { type: 'native', id: this.nativeId });
    if (this.title) appendEntry(this.session.file, { type: 'title', title: this.title, ...(this.titleBy ? { by: this.titleBy } : {}) });
    this._emit({ type: 'session_info_update', sessionId: this.sessionId });
  }

  async _turn(text, images = [], attribution = 'user', attachments = []) {
    if (!this.driver) {
      try {
        await this._driver();
      } catch (e) {
        this._emit({ type: 'notice', level: 'error', message: e.message });
        throw e;
      }
    }
    this.streaming = true;
    this.cur = null;
    this.tools = new Map();
    this.run = { startedAt: Date.now(), toolCalls: 0, from: this.messages.length, usage: { ...zeroUsage() } };
    this._emit({ type: 'agent_start' });
    const user = { role: 'user', id: uid('u'), content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType || 'image/png' }))], attribution, timestamp: Date.now() };
    if (attachments.length) user.attachments = attachments;
    this.messages.push(user);
    this._persist(user);
    this._emit({ type: 'message_start', message: user });
    this._emit({ type: 'message_end', message: user });
    if (!this.title && attribution === 'user') {
      this.title = makeTitle(text) || '';
      this.titleBy = 'auto';
      if (this.title && this.session) appendEntry(this.session.file, { type: 'title', title: this.title, by: 'auto' });
      if (this.title) this._emit({ type: 'session_info_update', title: this.title });
    }
    // Moved from another machine without the agent's own session: the first message carries what happened so far.
    if (this.handoff && attribution === 'user') {
      this.handoff = false;
      const past = this.messages.slice(0, -1).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-30).map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${clip((m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), 1500)}`).filter((l) => !/:\s*$/.test(l));
      if (past.length) text = `[This conversation moved to this machine from another computer, with its project. What happened so far:]\n${past.join('\n\n')}\n\n[Now:]\n${text}`;
    }
    // Files you attached go in as text the agent can read (each CLI reads the project itself).
    const att = attachments.map((x) => `\n\n<attached file="${x.name || x.path || 'file'}">\n${clip(String(x.text || ''), 100000)}\n</attached>`).join('');
    this.turnDone = new Promise((resolve) => (this._resolveTurn = resolve));
    this.driver.prompt(text + att, images);
    return this.turnDone;
  }

  _turnEnd({ status, error }) {
    if (!this.run) return;
    const run = this.run;
    const u = run.usage;
    const usage = { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite, ...(Number.isFinite(u.costUsd) ? { cost: { total: u.costUsd } } : {}) };
    if (this.cur) this.cur.usage = usage; // saved with the message
    const last = this._finishCur(status === 'aborted' ? 'aborted' : status === 'error' ? 'error' : 'stop', status === 'error' ? error || `${this.agent.name} stopped with an error` : undefined);
    const target = last || [...this.messages].reverse().find((m) => m.role === 'assistant' && this.messages.indexOf(m) >= run.from);
    if (status === 'error' && !last) {
      const msg = { role: 'assistant', content: [], provider: this.agent.id, model: this.model, stopReason: 'error', errorMessage: error || `${this.agent.name} stopped with an error`, timestamp: Date.now(), doneAt: Date.now() };
      this.messages.push(msg);
      this._persist(msg);
      this._emit({ type: 'message_start', message: msg });
      this._emit({ type: 'message_end', message: msg });
    }
    if (status === 'error') {
      const login = /not logged in|\/login|unauthori[sz]ed|sign in|log in/i.test(String(error || '')) && this.agent.login ? ` Sign in: run “${this.agent.login}” in a terminal, then send your message again.` : '';
      this._emit({ type: 'notice', level: 'error', message: `${error || `${this.agent.name} stopped with an error`}${login}` });
    }
    if (target && target.role === 'assistant' && target !== last) {
      target.usage = usage;
      if (this.session && !this.opts.noSession) appendEntry(this.session.file, { type: 'usage', id: target.id, usage });
    }
    this._addUsage({ ...usage, costUsd: u.costUsd });
    this.run = null;
    this.streaming = false;
    const summary = { status: status === 'completed' ? 'completed' : status, stopReason: status === 'completed' ? 'stop' : status, ...(error && status === 'error' ? { errorMessage: error } : {}), durationMs: Date.now() - run.startedAt, turns: 1, toolCalls: run.toolCalls, usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }, ...(Number.isFinite(u.costUsd) ? { cost: u.costUsd } : {}) };
    this._emit({ type: 'agent_end', isTerminal: true, messages: this.messages, ...summary });
    this._emit({ type: 'prompt_result', agentInvoked: true, sessionSettled: true, ...summary });
    this._emit({ type: 'session_settled' });
    this._resolveTurn?.(summary);
    if (status === 'aborted') {
      this.queue.steer.length = 0;
      this.queue.followUp.length = 0;
    } else {
      const next = this.queue.steer.shift() || this.queue.followUp.shift();
      if (next) setImmediate(() => !this.exited && !this.streaming && this._turn(next.text, next.images, next.attribution, next.attachments).catch(() => {}));
    }
  }

  // ---- Approvals ------------------------------------------------------------------------------------------------

  _cancelAsks() {
    for (const [id, resolve] of this.pendingAsk) {
      resolve({ cancelled: true });
      this._emit({ type: 'extension_ui_request', id: `cancel-${id}`, method: 'cancel', targetId: id });
    }
    this.pendingAsk.clear();
  }

  _askUser(title, options) {
    const id = `ask-${Date.now().toString(36)}-${++this.askSeq}`;
    return new Promise((resolve) => {
      this.pendingAsk.set(id, (ans) => resolve(ans?.cancelled ? null : ans?.value ?? null));
      this._emit({ type: 'extension_ui_request', id, method: 'select', title, options });
    });
  }

  /**
   * The agent wants to use a tool that needs permission. ORBIX's approval mode decides: Full access allows (except a
   * destructive command, which always asks), Auto edits allows file changes, Guarded also read-only commands, "Allow for this session" is remembered.
   */
  async _approve({ name, arguments: args = {}, raw }) {
    const mode = this.config.data.approvals;
    const command = name === 'bash' ? String(args.command || '') : '';
    // Command Guard: a command that wrecks the computer or an account is denied without asking.
    if (command && this.config.data.commandGuard !== false && catastrophicReason(command)) {
      this._emit({ type: 'notice', level: 'warn', message: `Command Guard blocked ${this.agent.name}: ${clip(command, 160)} (${catastrophicReason(command)}).` });
      return 'deny';
    }
    const risky = command && destructiveReason(command);
    const key = `${name}:${raw || ''}`;
    if (!risky) {
      if (mode === 'auto') return 'allow';
      if ((mode === 'edits' || mode === 'safe') && EDITS.has(name)) return 'allow';
      if (mode === 'safe' && command && readOnlyCommand(command)) return 'allow';
      if (this.allowAlways.has(key)) return 'allow';
    }
    const what = name === 'bash' ? `Run this command?  ${clip(command, 400)}` : EDITS.has(name) ? `${name === 'write' ? 'Write' : 'Change'} ${args.path ? args.path : 'files'}?` : `Allow ${raw || name}?  ${clip(JSON.stringify(args), 200)}`;
    const title = `${this.agent.name}: ${what}${risky ? `\n\nCareful: ${risky}` : ''}`;
    const ans = await this._askUser(title, risky ? ['Allow once', 'Deny'] : ['Allow once', 'Allow for this session', 'Deny']);
    if (ans === 'Allow for this session') {
      this.allowAlways.add(key);
      return 'allow_session';
    }
    return ans === 'Allow once' ? 'allow' : 'deny';
  }

  send(obj) {
    if (obj?.type === 'extension_ui_response' && this.pendingAsk.has(obj.id)) {
      this.pendingAsk.get(obj.id)(obj);
      this.pendingAsk.delete(obj.id);
    }
  }

  // ---- Requests from the UI ---------------------------------------------------------------------------------------

  async request(cmd) {
    const ok = (data) => ({ type: 'response', command: cmd.type, success: true, data });
    switch (cmd.type) {
      case 'get_state':
        return ok(this._state());
      case 'get_messages':
        return ok({ messages: this.messages });
      case 'get_available_models':
        return ok({ models: (await this.registry.models(this.agent.id)).map((m) => ({ ...m, provider: this.agent.id })) });
      case 'get_available_commands':
        return ok({ commands: this.cache.commands });
      case 'get_session_stats':
        return ok({ tokens: { input: this.usage.input, output: this.usage.output, cacheRead: this.usage.cacheRead, cacheWrite: this.usage.cacheWrite, total: this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite }, cost: this.costKnown ? this.cost : undefined, messages: this.messages.length });
      case 'get_context_budget':
        return ok({ cost: this.costKnown ? this.cost : undefined, contextOwner: this.agent.name, compactBlock: 'This agent manages its own context. ORBIX cannot guarantee which turns its compaction keeps.' });
      // An agent CLI builds its own system prompt; ORBIX never sees it.
      case 'get_system_prompt':
        return ok({ text: '', owner: this.agent.name });
      case 'get_subagents':
        return ok({ subagents: [] });
      case 'set_model': {
        if (!cmd.modelId) throw new Error('modelId is required');
        if (cmd.provider && cmd.provider !== this.agent.id) throw Object.assign(new Error(`This conversation runs on ${this.agent.name}. Start a new conversation to use another agent or model provider.`), { status: 400 });
        const id = cmd.modelId === 'default' ? '' : cmd.modelId;
        if (this.driver && id) await this.driver.setModel(id);
        this.model = id;
        if (this.session && !this.opts.noSession) appendEntry(this.session.file, { type: 'model', provider: this.agent.id, model: id });
        this._emit({ type: 'model_changed', model: this._state().model });
        return ok({});
      }
      case 'set_thinking_level': {
        const level = String(cmd.level || '');
        this.thinkingLevel = level === 'off' ? '' : level;
        if (this.driver && this.thinkingLevel) await this.driver.setEffort(this.thinkingLevel);
        return ok({ level: this.thinkingLevel || 'off' });
      }
      case 'set_session_name': {
        const name = String(cmd.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!name) throw Object.assign(new Error('A name is required'), { status: 400 });
        if (this.session) appendEntry(this.session.file, { type: 'title', title: name });
        this.title = name;
        this.titleBy = 'user';
        this._emit({ type: 'session_info_update', title: name });
        return ok({ title: name });
      }
      case 'abort':
        this.queue.steer.length = 0;
        this.queue.followUp.length = 0;
        this._cancelAsks();
        await this.driver?.interrupt();
        return ok({});
      case 'prompt': {
        const text = String(cmd.message ?? '');
        const { images, notes } = promptImages(cmd.images);
        const att = promptAttachments(cmd.attachments);
        for (const n of [...notes, ...att.notes]) this._emit({ type: 'notice', level: 'warn', message: n });
        if (!text.trim() && !images.length && !att.images.length && !att.attachments.length) throw new Error('Nothing to send');
        const men = await readMentions(this.backend, this.workspace, text).catch(() => []);
        const all = [...images, ...att.images, ...men.filter((m) => m.image).map((m) => m.image)];
        const files = [...att.attachments, ...men.filter((m) => !m.image)];
        if (this.streaming) {
          this.queue[cmd.streamingBehavior === 'followUp' ? 'followUp' : 'steer'].push({ text, images: all, attachments: files, attribution: 'user' });
          return ok({ queued: true });
        }
        this._turn(text, all, 'user', files).catch((e) => this.emit('stderr', String(e?.stack || e)));
        return ok({});
      }
      case 'compact':
        if (this.streaming) throw new Error('Wait for the agent to finish (or stop it), then compact.');
        this._turn('/compact', [], 'command').catch(() => {});
        return ok({});
      case 'export_html': {
        const file = writeExport({ title: this.title || 'Conversation', workspace: this.workspace, model: `${this.agent.name}${this.model ? ` · ${this.model}` : ''}`, messages: this.messages });
        return ok({ path: file });
      }
      case 'bash': {
        this.bashCtl = new AbortController();
        const r = await this.consoleTools.run('bash', { command: cmd.command, timeout: 300, ...(cmd.shell ? { shell: cmd.shell } : {}) }, {});
        return ok({ exitCode: r.details?.exitCode ?? (r.isError ? 1 : 0), output: r.text, cancelled: !!r.details?.aborted, workingDir: this.workspace, durationMs: r.details?.durationMs });
      }
      case 'abort_bash':
        this.bashCtl?.abort();
        return ok({});
      case 'side_question':
        throw Object.assign(new Error(`Side questions use ORBIX’s own agent. Ask ${this.agent.name} in the conversation instead.`), { status: 400 });
      default:
        throw Object.assign(new Error(`${this.agent.name} conversations do not support “${cmd.type}”.`), { status: 400 });
    }
  }

  _state() {
    const thinking = this.agent.kind === 'claude' ? { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], mode: 'effort', canOff: true } : this.agent.kind === 'codex' ? { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], mode: 'effort', canOff: true } : undefined;
    return {
      model: { id: this.model || 'default', provider: this.agent.id, name: this.model ? `${this.model}` : `${this.agent.name} default`, reasoning: !!thinking, input: ['text', 'image'], contextWindow: this.contextWindow, thinking },
      agent: { id: this.agent.id, name: this.agent.name, kind: this.agent.kind, nativeId: this.nativeId, limits: this.limits },
      thinkingLevel: this.thinkingLevel || 'off',
      isStreaming: this.streaming,
      turnStartedAt: this.streaming ? this.run?.startedAt || null : null,
      isCompacting: false,
      sessionId: this.sessionId,
      autoCompactionEnabled: true,
      planMode: false,
      contextUsage: null,
      queuedMessageCount: this.queue.steer.length + this.queue.followUp.length,
      queuedMessages: { steering: this.queue.steer.map((x) => x.text), followUp: this.queue.followUp.map((x) => x.text), liveSteered: 0 },
      todoPhases: this.todoPhases || [],
      messageCount: this.messages.length,
      tools: [],
      approvals: this.config.data.approvals,
      worktree: this.worktreeView(),
      features: ['attachments', 'prompt_status'],
    };
  }

  worktreeView() {
    if (!this.worktree) return null;
    const { branch, baseBranch, base, slug, source } = this.worktree;
    return { branch, baseBranch, base, slug, source, state: this.worktreeState?.state || '', hash: this.worktreeState?.hash || '' };
  }

  setWorktreeState(state, extra = {}) {
    if (!this.worktree) return;
    this.worktreeState = { state, hash: extra.hash || '', at: Date.now() };
    if (this.session && !this.opts.noSession) appendEntry(this.session.file, { type: 'worktree', ...this.worktreeState });
    this._emit({ type: 'worktree_update', worktree: this.worktreeView() });
  }

  _isReadOnly() {
    return false;
  }

  _persistRaw(entry) {
    if (this.opts.noSession) return;
    this._ensureSession();
    appendEntry(this.session.file, entry);
  }

  async stop(ms = 2500) {
    if (this.exited) return;
    this.exited = true;
    this._cancelAsks();
    this.bashCtl?.abort();
    if (this.streaming) await this.driver?.interrupt().catch(() => {});
    if (this.run) this._turnEnd({ status: 'aborted' });
    await Promise.race([this.driver?.close(), new Promise((r) => setTimeout(r, Math.max(500, ms)))]).catch(() => {});
    this.driver = null;
    this.streaming = false;
    if (this.session) closeSession(this.session.file);
    this.emit('exit', 0);
  }
}
