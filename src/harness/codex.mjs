// Codex as an ORBIX agent: `codex app-server` (JSON-RPC over stdio), one thread per conversation. Codex keeps its
// loop, sandbox, login and rollout history (~/.codex/sessions); ORBIX starts turns, shows the items as steps and
// answers Codex's approval requests with its own approval cards.
import { EventEmitter } from 'node:events';
import { LineProcess, Rpc } from './lines.mjs';
import { fromCodex, resultText } from './tools.mjs';

/** ORBIX approvals → Codex policy. The sandbox stays on: commands write only inside the project. */
const POLICY = { ask: 'untrusted', edits: 'on-request', auto: 'on-request' };

export class CodexDriver extends EventEmitter {
  constructor({ backend, bin, cwd, approvals }) {
    super();
    this.backend = backend;
    this.bin = bin;
    this.cwd = cwd;
    this.approvals = approvals;
    this.threadId = '';
    this.turnId = '';
    this.model = '';
    this.effort = '';
    this.busy = false;
    this.items = new Map(); // item id → { tool, output }
    this.ask = async () => 'deny';
  }

  async _open() {
    this.lp = new LineProcess(this.backend.spawn([this.bin, 'app-server'], { cwd: this.cwd, env: { CODEX_DISABLE_UPDATE_CHECK: '1' }, quiet: true }));
    this.rpc = new Rpc(this.lp, { jsonrpc: false, onRequest: (m, p) => this._request(m, p), onNotify: (m, p) => this._notify(m, p) });
    this.lp.on('exit', (code) => {
      if (this.busy) this._end('error', this.lp.why() || `Codex stopped (exit ${code})`);
      this.emit('exit', { code, why: this.lp.why() });
    });
    await this.rpc.call('initialize', { clientInfo: { name: 'orbix', title: 'ORBIX', version: '1' }, capabilities: { experimentalApi: true } }, { timeout: 60000 });
    this.rpc.notify('initialized');
  }

  async start({ model, resume, effort }) {
    await this._open();
    const opts = { cwd: this.backend.execPath(this.cwd), approvalPolicy: POLICY[this.approvals] || 'untrusted', sandbox: 'workspace-write', ...(model ? { model } : {}) };
    const r = resume ? await this.rpc.call('thread/resume', { threadId: resume, excludeTurns: true, ...opts }) : await this.rpc.call('thread/start', opts);
    this.threadId = r.thread?.id || resume || '';
    this.model = r.model || model || '';
    this.effort = effort || r.reasoningEffort || '';
    this.emit('native', { id: this.threadId, model: this.model });
    return { nativeId: this.threadId, model: this.model, commands: [] };
  }

  /** Codex's own model list, for the model picker. */
  async models() {
    const out = [];
    let cursor = null;
    for (let i = 0; i < 5; i++) {
      const r = await this.rpc.call('model/list', { cursor, limit: 100 });
      out.push(...(r.data || []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  prompt(text, images = []) {
    this.busy = true;
    this.items.clear();
    const input = [{ type: 'text', text, text_elements: [] }, ...images.map((i) => ({ type: 'image', url: `data:${i.mimeType || 'image/png'};base64,${i.data}` }))];
    this.rpc.call('turn/start', { threadId: this.threadId, input, ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}) }, { timeout: 60000 })
      .then((r) => (this.turnId = r?.turn?.id || this.turnId))
      .catch((e) => this._end('error', e.message));
  }

  async interrupt() {
    if (!this.busy || !this.turnId) return;
    await this.rpc.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, { timeout: 10000 }).catch(() => {});
  }

  async setModel(model) {
    this.model = model; // applies from the next turn (turn/start carries it)
  }

  async setEffort(level) {
    this.effort = level;
  }

  async setMode(approvals) {
    this.approvals = approvals;
  }

  close() {
    return this.lp?.close(2000);
  }

  _end(status, error) {
    if (!this.busy) return;
    this.busy = false;
    this.emit('turn_end', { status, error });
  }

  _notify(method, p) {
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return; // a subagent's thread
    switch (method) {
      case 'turn/started':
        this.turnId = p.turn?.id || this.turnId;
        return;
      case 'item/agentMessage/delta':
        if (p.delta) this.emit('text', { key: p.itemId, delta: p.delta });
        return;
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (p.delta) this.emit('thinking', { key: p.itemId, delta: p.delta });
        return;
      case 'item/started': {
        const t = fromCodex(p.item);
        if (!t) return;
        this.items.set(p.item.id, { output: '' });
        this.emit('tool_start', { id: p.item.id, ...t });
        return;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const it = this.items.get(p.itemId);
        if (!it) return;
        it.output += p.delta || '';
        this.emit('tool_update', { id: p.itemId, output: it.output });
        return;
      }
      case 'item/completed': {
        const item = p.item || {};
        if (item.type === 'agentMessage' && item.text) this.emit('text_final', { key: item.id, text: item.text });
        const t = fromCodex(item);
        if (!t) return;
        if (!this.items.has(item.id)) this.emit('tool_start', { id: item.id, ...t });
        this.items.delete(item.id);
        const failed = item.status === 'failed' || item.status === 'declined' || item.success === false || !!item.error;
        let output = item.aggregatedOutput ?? '';
        if (item.type === 'fileChange') output = (item.changes || []).map((c) => `${c.kind?.type || 'update'} ${c.path}\n${c.diff || ''}`).join('\n');
        if (item.type === 'mcpToolCall') output = resultText(item.result?.content) || item.error?.message || '';
        if (item.type === 'dynamicToolCall') output = resultText(item.contentItems);
        if (item.exitCode != null && item.exitCode !== 0) output += `\n(exit ${item.exitCode})`;
        this.emit('tool_end', { id: item.id, output: output || (item.status === 'declined' ? 'Declined' : ''), isError: failed, exitCode: item.exitCode });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage?.last;
        if (u) this.emit('usage', { input: Math.max(0, (u.inputTokens || 0) - (u.cachedInputTokens || 0)), output: u.outputTokens || 0, cacheRead: u.cachedInputTokens || 0, cacheWrite: u.cacheWriteInputTokens || 0, contextWindow: p.tokenUsage.modelContextWindow || undefined });
        return;
      }
      case 'turn/completed': {
        const s = p.turn?.status;
        this._end(s === 'completed' ? 'completed' : s === 'interrupted' ? 'aborted' : 'error', p.turn?.error?.message);
        return;
      }
      case 'error':
        if (!p.willRetry) this.emit('notice', { level: 'error', message: p.error?.message || 'Codex reported an error' });
        return;
      case 'account/rateLimits/updated':
        this.emit('limits', p.rateLimits || p);
        return;
      default:
    }
  }

  async _request(method, p) {
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const command = Array.isArray(p.command) ? p.command.join(' ') : p.command || '';
      const ans = await this.ask({ id: p.itemId || p.callId, name: 'bash', arguments: { command, ...(p.reason ? { description: p.reason } : {}) }, raw: 'commandExecution' }).catch(() => 'deny');
      return { decision: ans === 'allow' ? 'accept' : ans === 'allow_session' ? 'acceptForSession' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const ans = await this.ask({ id: p.itemId || p.callId, name: 'edit', arguments: { path: p.grantRoot || '', description: p.reason || 'Change files' }, raw: 'fileChange' }).catch(() => 'deny');
      return { decision: ans === 'allow' ? 'accept' : ans === 'allow_session' ? 'acceptForSession' : 'decline' };
    }
    throw Object.assign(new Error(`ORBIX does not handle ${method}`), { code: -32601 });
  }
}
