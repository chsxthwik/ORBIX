// Any Agent Client Protocol agent as an ORBIX agent (OpenCode `opencode acp`, Gemini CLI, Hermes, your own): JSON-RPC
// 2.0 over stdio. The agent keeps its loop, tools and login; ORBIX opens or loads its session, sends prompts, shows
// session/update notifications as steps and answers session/request_permission with its approval cards.
import { EventEmitter } from 'node:events';
import { LineProcess, Rpc } from './lines.mjs';
import { fromAcp, resultText } from './tools.mjs';

const PROTOCOL_VERSION = 1;
const cancelled = { outcome: { outcome: 'cancelled' } };

export class AcpDriver extends EventEmitter {
  constructor({ backend, argv, cwd, approvals, env, name }) {
    super();
    this.backend = backend;
    this.argv = argv;
    this.cwd = cwd;
    this.approvals = approvals;
    this.env = env || {};
    this.name = name || 'The agent';
    this.sessionId = '';
    this.busy = false;
    this.loading = false;
    this.models = [];
    this.model = '';
    this.capabilities = null;
    this.commands = [];
    this.tools = new Map();
    this.textKey = 0;
    this.ask = async () => 'deny';
  }

  async start({ model, resume }) {
    this.lp = new LineProcess(this.backend.spawn(this.argv, { cwd: this.cwd, env: this.env, quiet: true }));
    this.rpc = new Rpc(this.lp, { onRequest: (m, p) => this._request(m, p), onNotify: (m, p) => this._notify(m, p) });
    this.lp.on('exit', (code) => {
      if (this.busy) this._end('error', this.lp.why() || `${this.name} stopped (exit ${code})`);
      this.emit('exit', { code, why: this.lp.why() });
    });
    try {
      return await this._openSession(model, resume);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async _openSession(model, resume) {
    const init = await this.rpc.call('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'orbix', title: 'ORBIX', version: '1' } }, { timeout: 60000 });
    if (init?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`${this.name} reported ACP protocol ${init?.protocolVersion ?? 'unknown'}; ORBIX supports ACP ${PROTOCOL_VERSION}.`);
    }
    this.capabilities = {
      protocolVersion: init.protocolVersion,
      version: typeof init.agentInfo?.version === 'string' ? init.agentInfo.version : undefined,
      loadSession: init.agentCapabilities?.loadSession === true,
      image: init.agentCapabilities?.promptCapabilities?.image === true,
    };
    const cwd = this.backend.execPath(this.cwd);
    let r;
    if (resume && this.capabilities.loadSession) {
      this.loading = resume; // ORBIX has its own copy of the history: the replay is not shown again
      try {
        r = await this.rpc.call('session/load', { sessionId: resume, cwd, mcpServers: [] });
        this.sessionId = resume;
      } catch (e) {
        this.emit('notice', { level: 'warn', message: `${this.name} could not reopen its session (${e.message}); it starts a new one with no memory of this conversation.` });
      } finally {
        this.loading = false;
      }
    } else if (resume) {
      this.emit('notice', { level: 'warn', message: `${this.name} does not support reopening ACP sessions. It starts a new one with no memory of this conversation.` });
    }
    if (!this.sessionId) {
      r = await this.rpc.call('session/new', { cwd, mcpServers: [] });
      if (typeof r?.sessionId !== 'string' || !r.sessionId) throw new Error(`${this.name} did not return an ACP session ID.`);
      this.sessionId = r.sessionId;
    }
    this._readModels(r);
    if (model && model !== this.model) await this.setModel(model).catch((e) => this.emit('notice', { level: 'warn', message: e.message }));
    this.emit('native', { id: this.sessionId, model: this.model });
    return { nativeId: this.sessionId, model: this.model, commands: this.commands };
  }

  _readModels(r = {}) {
    if (r?.models?.availableModels) {
      this.models = r.models.availableModels.map((m) => ({ id: m.modelId, name: m.name || m.modelId }));
      this.model = r.models.currentModelId || this.model;
    }
    const opt = (r?.configOptions || []).find((o) => (o.id === 'model' || o.category === 'model') && o.type === 'select');
    if (opt) {
      this.modelOption = opt.id;
      const list = (opt.options || []).flatMap((o) => (Array.isArray(o.options) ? o.options : [o]));
      if (list.length) this.models = list.map((o) => ({ id: o.value ?? o.id, name: o.name || o.value || o.id }));
      this.model = opt.currentValue || this.model;
    }
  }

  prompt(text, images = []) {
    this.busy = true;
    this.textKey++;
    const prompt = [{ type: 'text', text }, ...(this.capabilities.image ? images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType || 'image/png' })) : [])];
    this.rpc.call('session/prompt', { sessionId: this.sessionId, prompt }, { timeout: 0 })
      .then((r) => {
        const s = r?.stopReason;
        this._end(s === 'cancelled' ? 'aborted' : s === 'end_turn' || s === 'max_turn_requests' || s === 'max_tokens' || !s ? 'completed' : 'error', s === 'refusal' ? 'The model refused' : undefined);
      })
      .catch((e) => this._end('error', e.message));
  }

  async interrupt() {
    if (this.busy) this.rpc.notify('session/cancel', { sessionId: this.sessionId });
  }

  async setModel(model) {
    if (this.modelOption) {
      const r = await this.rpc.call('session/set_config_option', { sessionId: this.sessionId, configId: this.modelOption, value: model });
      this._readModels(r);
    } else {
      await this.rpc.call('session/set_model', { sessionId: this.sessionId, modelId: model });
      this.model = model;
    }
    return this.model;
  }

  async setEffort() {}

  async setMode(approvals) {
    this.approvals = approvals;
  }

  close() {
    return this.lp?.close(2000);
  }

  _end(status, error) {
    if (!this.busy) return;
    this.busy = false;
    this.tools.clear();
    this.emit('turn_end', { status, error });
  }

  _notify(method, p) {
    if (method !== 'session/update' || (this.sessionId && p.sessionId !== this.sessionId) || (this.loading && p.sessionId !== this.loading)) return;
    const u = p.update || {};
    if (u.sessionUpdate === 'config_option_update') {
      this._readModels(u);
      if (!this.loading && this.sessionId) this.emit('model', this.model);
      return;
    }
    if (u.sessionUpdate === 'available_commands_update') {
      this.commands = (u.availableCommands || []).map((c) => ({ name: c.name, description: c.description || '', source: 'agent' }));
      this.emit('commands', this.commands);
      return;
    }
    if (this.loading || !this.busy) return;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text' && u.content.text) this.emit('text', { key: `t${this.textKey}`, delta: u.content.text });
        return;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text' && u.content.text) this.emit('thinking', { key: `r${this.textKey}`, delta: u.content.text });
        return;
      case 'tool_call': {
        this.textKey++; // text after a step starts a new block
        const t = fromAcp(u);
        this.tools.set(u.toolCallId, { call: u, output: '' });
        this.emit('tool_start', { id: u.toolCallId, ...t });
        if (u.status === 'completed' || u.status === 'failed') this._toolDone(u.toolCallId, u);
        return;
      }
      case 'tool_call_update': {
        const it = this.tools.get(u.toolCallId);
        if (!it) return;
        Object.assign(it.call, Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)));
        if (u.title || u.rawInput) this.emit('tool_args', { id: u.toolCallId, ...fromAcp(it.call) });
        const out = resultText(u.content);
        if (out) this.emit('tool_update', { id: u.toolCallId, output: out });
        if (u.status === 'completed' || u.status === 'failed') this._toolDone(u.toolCallId, it.call);
        return;
      }
      case 'plan':
        this.emit('plan', (u.entries || []).map((e) => ({ text: e.content, status: e.status })));
        return;
      default:
    }
  }

  _toolDone(id, call) {
    if (!this.tools.has(id)) return;
    this.tools.delete(id);
    const raw = call.rawOutput;
    const out = resultText(call.content) || (typeof raw === 'string' ? raw : raw?.output ?? raw?.stdout ?? (raw ? JSON.stringify(raw).slice(0, 20000) : ''));
    this.emit('tool_end', { id, output: String(out || ''), isError: call.status === 'failed' });
  }

  async _request(method, p) {
    if (method === 'session/request_permission') {
      if (!this.busy || p.sessionId !== this.sessionId) return cancelled;
      const t = fromAcp(p.toolCall || {});
      const ans = await this.ask({ id: p.toolCall?.toolCallId, ...t, raw: p.toolCall?.kind }).catch(() => 'deny');
      const opts = p.options || [];
      // ORBIX owns session-scoped approvals. Never turn a one-time approval into a persistent agent rule.
      const want = ans === 'allow' || ans === 'allow_session' ? 'allow_once' : 'reject_once';
      const o = opts.find((x) => x.kind === want);
      return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : cancelled;
    }
    throw Object.assign(new Error(`ORBIX does not offer ${method}`), { code: -32601 });
  }
}
