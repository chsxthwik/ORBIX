// The ORBIX agent: one conversation's agent loop (model streaming, tools, approvals, compaction, subagents, undo).
// It has the same request()/send()/events surface as an OMP RPC process (src/proc.mjs), so the server and UI
// treat both engines alike. Its engine id on the wire is 'builtin'.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { clip, makeTitle, uid, textOf } from '../util.mjs';
import { isWinPath } from '../backend.mjs';
import * as providers from './providers.mjs';
import { NEEDS_APPROVAL, READ_ONLY, createTools, toolDefsFor, invalidArgsText } from './tools.mjs';
import { createSession, appendEntry, closeSession, loadSession, repairTail, branchSession } from './store.mjs';
import { loadInstructions, readMentions, promptAttachments, promptImages } from './context.mjs';
import { compactLimit, contextMessages, contextTokens, estimateTokens, findCut, lastMarker, rebuildSession, summarize, tokenScale } from './compact.mjs';
import { runTasks, SUBAGENT_TOOLS } from './subagent.mjs';
import { TurnAssembler, collectTurn } from './assemble.mjs';
import { HookRunner } from './hooks.mjs';
import { stripSgr } from './files.mjs';
import { buildSystemPrompt, environmentFacts, subagentPrompt } from './prompt.mjs';
import { McpManager } from './mcp.mjs';
import { discoverSkills, skillsPrompt } from './skills.mjs';
import { BUILTIN_COMMANDS, discoverCommands } from './commands.mjs';
import { runSlash } from './slash.mjs';
import { loadCatalog, modelInfo, costOf } from './catalog.mjs';
import { writeExport } from './export.mjs';

const MAX_TURNS = 100;

/** The request for one round of goal mode. */
function goalPrompt(g) {
  const rules = 'When the goal is fully achieved and checked, end your reply with a last line that contains only GOAL_DONE. If you need a decision or information from the user, ask one clear question and stop (do not write GOAL_DONE).';
  return g.round === 1
    ? `[Goal round 1/${g.max}]\nGoal: ${g.text}\n\nWork on this goal by yourself: plan it, do it, verify it. ${rules}`
    : `[Goal round ${g.round}/${g.max}]\nContinue working toward the goal: ${g.text}\n\nCheck what is still missing and do it. ${rules}`;
}
const MID_STREAM_RETRY_MS = 1500;
const CONTINUE_TEXT = 'Your previous reply was cut off by the output token limit. Continue exactly where it stopped, without repeating what you already wrote.';
/** Protocol additions over OMP's RPC that this engine supports (the UI can show the matching actions). */
const FEATURES = ['regenerate', 'edit_message', 'attachments', 'prompt_status', 'branch'];
const GOAL_ROUNDS = 6;
const TITLE_SYSTEM = 'You name chat sessions. Reply with only a title of at most 6 words for the conversation that starts with the message below: no quotes, no trailing punctuation, same language as the message.';

/** Model facts (context window, prices) from the catalog; waits at most 3 s for a first download, then goes on without. */
async function catalogReady() {
  await Promise.race([loadCatalog(), new Promise((r) => setTimeout(r, 3000).unref?.())]).catch(() => {});
}

/** True when a message the user typed names `host` as a whole word ("10.0.0.1" does not match "10.0.0.15"). */
export function userMentionsHost(messages, host) {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w.-])${esc}(?![\\w-]|\\.\\w)`, 'i');
  return messages.some((m) => m.role === 'user' && (m.attribution === 'user' || m.attribution === 'steer') && (m.content || []).some((c) => c.type === 'text' && re.test(c.text)));
}

const isOverflow = (msg) => /context|too long|too many tokens|maximum.*tokens|token limit|prompt is too long|reduce the length/i.test(msg || '') && /exceed|maximum|limit|too long|too large|reduce/i.test(msg || '');
const hasAnswer = (m) => m.content.some((c) => (c.type === 'text' && c.text.trim()) || c.type === 'toolCall');
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** Wait `ms`, or less when `signal` aborts (at once when it already has). Never rejects. */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

export class AgentProc extends EventEmitter {
  constructor({ id, backend, workspace, resume, model, noSession, config }) {
    super();
    this.id = id;
    this.backend = backend;
    this.workspace = workspace;
    this.opts = { resume, model, noSession };
    this.config = config;
    this.engine = 'builtin';
    this.ready = false;
    this.exited = false;
    this.protocol = 'builtin';
    this.streaming = false;
    this.compacting = false;
    this.stderrTail = [];
    this.startedAt = Date.now();
    this.info = { type: 'ready', engine: 'builtin' };
    this.cache = { commands: [] };
    this.messages = [];
    this.title = '';
    this.session = null;
    this.sessionId = null;
    // An explicit model wins; otherwise the saved default ("provider/model" or a bare model id).
    const spec = this._parseSpec(model || config.data.defaultModel || '');
    this.provider = spec.provider || '';
    this.model = spec.model || '';
    this.models = null;
    this.meta = null;
    this.thinkingLevel = 'off';
    this.planMode = false;
    this.autoCompact = true;
    this.allowAlways = new Set();
    this.allowedHosts = new Set();
    this.pendingAsk = new Map();
    this.askSeq = 0;
    this.abortCtl = null;
    this.bashCtl = null;
    this.queue = { steer: [], followUp: [] };
    this.checkpoints = new Map();
    this.undone = new Set();
    this.todoPhases = [];
    this.usage = zeroUsage();
    this.cost = 0;
    this.costKnown = false;
    this.dropped = { ...zeroUsage(), cost: 0 }; // spent on replies that were regenerated or edited away
    this.subagents = new Map();
    this.taskSeq = 0;
    this.run = null;
    this.roles = { fast: '', plan: '' }; // this session's override of the model roles ("provider/model"); '' = use the saved default
    this.goal = null; // { text, round, max } while /goal is running
    this.envFacts = null; // environment block of the system prompt, captured once (stable prefix for caching)
    this.defs = toolDefsFor(backend);
    this.tools = createTools({ backend, cwd: workspace, getSignal: () => this.abortCtl?.signal });
    this.consoleTools = createTools({ backend, cwd: workspace, getSignal: () => this.bashCtl?.signal });
    this.hooks = new HookRunner({ backend, workspace, hostRoot: backend.hostPath(workspace), getSessionId: () => this.sessionId, ask: (title, options) => this._askUser(title, options), notice: (level, message) => this._emit({ type: 'notice', level, message }) });
    this.mcp = new McpManager({ backend, workspace, hostRoot: backend.hostPath(workspace), ask: (title, options) => this._askUser(title, options), notice: (level, message) => this._emit({ type: 'notice', level, message }) });
  }

  _parseSpec(spec) {
    const s = String(spec || '').trim();
    const i = s.indexOf('/');
    if (i > 0 && this.config.provider(s.slice(0, i))) return { provider: s.slice(0, i), model: s.slice(i + 1) };
    return { model: s };
  }

  async start() {
    if (this.opts.resume) {
      repairTail(this.opts.resume); // a crash mid-write must not swallow the next entry
      const s = loadSession(this.opts.resume);
      if (!s.header) throw new Error('That saved conversation could not be read');
      const rebuilt = rebuildSession(this.opts.resume);
      this.messages = rebuilt.messages;
      this.title = s.title;
      this.session = { id: s.header.id, file: this.opts.resume };
      this.sessionId = s.header.id;
      for (const c of s.checkpoints || []) this.checkpoints.set(c.toolCallId, c.undo);
      for (const id of s.undone || []) this.undone.add(id);
      for (const m of this.messages) if (m.role === 'toolResult') {
        if (m.details?.undoable && this.undone.has(m.toolCallId)) m.details.undone = true;
        if (m.toolName === 'todo' && m.details?.phases) this.todoPhases = m.details.phases;
        if (m.toolName === 'task') for (const p of m.details?.progress || []) this.subagents.set(p.id, { ...p, progress: p });
      }
      const ex = rebuilt.extras;
      if (!this.opts.model && ex.model) {
        this.model = ex.model;
        this.provider = ex.provider || this.provider;
      }
      if (!this.provider && s.header.provider) this.provider = s.header.provider;
      if (!this.model && s.header.model) this.model = s.header.model;
      if (ex.thinkingLevel) this.thinkingLevel = ex.thinkingLevel;
      if (ex.roles) this.roles = { fast: ex.roles.fast || '', plan: ex.roles.plan || '' };
      this.planMode = ex.planMode;
      this.dropped = { ...zeroUsage(), cost: 0, ...ex.droppedUsage };
      this._recomputeUsage();
    }
    this._envFacts().catch(() => {}); // warm up (git status) while the user types
    await this._refreshMeta(false).catch(() => {});
    this.ready = true;
    this.cache.commands = await this._commands().catch(() => []);
    this._emit({ type: 'available_commands_update', commands: this.cache.commands });
    return this;
  }

  send(obj) {
    if (obj?.type === 'extension_ui_response' && this.pendingAsk.has(obj.id)) {
      this.pendingAsk.get(obj.id)(obj);
      this.pendingAsk.delete(obj.id);
    }
  }

  async request(cmd) {
    const ok = (data) => ({ type: 'response', command: cmd.type, success: true, data });
    switch (cmd.type) {
      case 'get_state':
        if (this.planMode && !this._planShown) {
          this._planShown = true;
          setImmediate(() => this._planStatus());
        }
        return ok(this._state());
      case 'get_messages':
        return ok({ messages: this.messages });
      case 'get_available_models':
        return ok({ models: await this._models() });
      case 'get_available_commands':
        this.cache.commands = await this._commands();
        return ok({ commands: this.cache.commands });
      case 'get_session_stats':
        return ok(this._stats());
      case 'get_subagents':
        return ok({ subagents: [...this.subagents.values()] });
      case 'set_subagent_subscription':
        return ok({ level: cmd.level });
      case 'set_model': {
        if (!cmd.modelId) throw new Error('modelId is required');
        await this._setModel(cmd.provider, cmd.modelId);
        return ok({});
      }
      case 'set_thinking_level':
        return ok({ level: await this._setThinking(String(cmd.level || 'off')) });
      case 'cycle_thinking_level': {
        await this._refreshMeta(false);
        const all = ['off', ...(this.meta?.levels || [])];
        if (all.length < 2) throw new Error('This model has no thinking levels');
        return ok({ level: await this._setThinking(all[(all.indexOf(this.thinkingLevel) + 1) % all.length]) });
      }
      case 'set_auto_compaction':
        this.autoCompact = cmd.enabled !== false;
        return ok({ enabled: this.autoCompact });
      case 'compact': {
        if (this.streaming) throw new Error('Wait for the agent to finish (or stop it), then compact.');
        this._exclusive(() => this._compactCmd(cmd.customInstructions || cmd.focus || '')).catch((e) => this.emit('stderr', String(e?.stack || e)));
        return ok({});
      }
      case 'set_fast_mode':
        throw new Error('Fast mode is not available in the ORBIX agent');
      case 'export_html': {
        const file = writeExport({ title: this.title || 'Conversation', workspace: this.workspace, model: this.model ? `${this.provider}/${this.model}` : '', messages: this.messages });
        return ok({ path: file });
      }
      case 'set_session_name':
        this.title = String(cmd.name || '').trim();
        if (this.session) appendEntry(this.session.file, { type: 'title', title: this.title });
        return ok({});
      case 'abort':
        this._endGoal(this.goal ? 'Goal stopped.' : '');
        this.queue.steer.length = 0;
        this.queue.followUp.length = 0;
        this.abortCtl?.abort();
        this._cancelAsks();
        return ok({});
      case 'undo': {
        const r = cmd.toolCallId ? await this._undoIds([cmd.toolCallId]) : await this._undoLastTurn();
        if (!r.ok) throw new Error(r.text);
        return ok({ text: r.text });
      }
      case 'prompt': {
        const text = String(cmd.message ?? '');
        const { images, notes } = promptImages(cmd.images);
        const att = promptAttachments(cmd.attachments);
        for (const n of [...notes, ...att.notes]) this._emit({ type: 'notice', level: 'warn', message: n });
        const all = [...images, ...att.images];
        if (!text.trim() && !all.length && !att.attachments.length) throw new Error('Nothing to send');
        if (text.trim().startsWith('/') && !all.length && !att.attachments.length) {
          const r = await runSlash(this, text.trim());
          if (r === true) return ok({ agentInvoked: false });
          if (r?.started) return ok({});
          if (r && typeof r === 'object') return this._prompt(r.text, all, att.attachments, cmd, ok, r.attribution || 'command');
        }
        return this._prompt(text, all, att.attachments, cmd, ok);
      }
      case 'regenerate':
        return ok(await this._regenerate(cmd));
      case 'branch':
        return ok(this._branch(cmd));
      case 'edit_message':
        return ok(await this._editMessage(cmd));
      case 'bash': {
        this.bashCtl = new AbortController();
        const r = await this.consoleTools.run('bash', { command: cmd.command, timeout: 300, ...(cmd.shell ? { shell: cmd.shell } : {}) }, {});
        return ok({ exitCode: r.details?.exitCode ?? (r.isError ? 1 : 0), output: r.text, cancelled: !!r.details?.aborted, workingDir: this.workspace, durationMs: r.details?.durationMs });
      }
      case 'abort_bash':
        this.bashCtl?.abort();
        return ok({});
      default:
        throw new Error(`"${cmd.type}" is not supported by the ORBIX agent`);
    }
  }

  /** `attribution` 'command' marks text expanded from a skill or custom command file (not typed by the user). */
  _prompt(text, images, attachments, cmd, ok, attribution = 'user') {
    if (this.streaming) {
      this.queue[cmd.streamingBehavior === 'followUp' ? 'followUp' : 'steer'].push({ text, images, attachments, attribution });
      return ok({ queued: true });
    }
    this._run(text, images, attribution, attachments).catch((e) => this.emit('stderr', String(e?.stack || e)));
    return ok({});
  }

  _state() {
    const meta = this.meta || {};
    const m = this.model
      ? {
          id: this.model,
          provider: this.provider || undefined,
          name: this._modelName(this.model),
          reasoning: !!meta.levels?.length,
          input: meta.info?.vision === false ? ['text'] : ['text', 'image'],
          contextWindow: meta.contextWindow,
          maxTokens: meta.info?.maxOutput,
          cost: meta.info?.cost,
          thinking: meta.levels?.length ? { efforts: meta.levels, mode: 'effort' } : undefined,
        }
      : null;
    return {
      model: m,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.streaming,
      isCompacting: this.compacting,
      sessionId: this.sessionId,
      autoCompactionEnabled: this.autoCompact,
      planMode: this.planMode,
      contextUsage: this._contextUsage(),
      queuedMessageCount: this.queue.steer.length + this.queue.followUp.length,
      queuedMessages: { steering: this.queue.steer.map((x) => x.text), followUp: this.queue.followUp.map((x) => x.text), liveSteered: 0 },
      todoPhases: this.todoPhases,
      messageCount: this.messages.length,
      tools: this._toolDefs().map((t) => t.name),
      approvals: this.config.data.approvals,
      features: FEATURES,
    };
  }

  _contextUsage() {
    const cw = this.meta?.contextWindow;
    if (!cw) return undefined;
    const tokens = contextTokens(this.messages);
    return { tokens, contextWindow: cw, percent: Math.min(100, (tokens / cw) * 100), estimated: !this.meta?.contextWindowKnown };
  }

  _stats() {
    const count = (role) => this.messages.filter((m) => m.role === role).length;
    const toolCalls = this.messages.reduce((n, m) => n + (m.role === 'assistant' ? (m.content || []).filter((c) => c.type === 'toolCall').length : 0), 0);
    const u = this.usage;
    return {
      sessionFile: this.session?.file,
      sessionId: this.sessionId,
      userMessages: count('user'),
      assistantMessages: count('assistant'),
      toolCalls,
      toolResults: count('toolResult'),
      totalMessages: this.messages.length,
      tokens: { ...u, total: u.input + u.output + u.cacheRead + u.cacheWrite },
      cost: this.costKnown ? this.cost : undefined,
      contextUsage: this._contextUsage(),
    };
  }

  _addUsage(usage, cost) {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) this.usage[k] += usage?.[k] || 0;
    if (Number.isFinite(cost)) {
      this.cost += cost;
      this.costKnown = true;
    }
  }

  /** Usage and cost of a list of messages: { input, output, cacheRead, cacheWrite, cost, costKnown }. */
  _usageOf(messages) {
    const sum = { ...zeroUsage(), cost: 0, costKnown: false };
    const add = (u, c) => {
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) sum[k] += u?.[k] || 0;
      if (Number.isFinite(c)) {
        sum.cost += c;
        sum.costKnown = true;
      }
    };
    for (const m of messages) {
      if (m.role === 'assistant' && m.usage) add(m.usage, m.usage.cost?.total);
      else if (m.role === 'toolResult' && m.toolName === 'task' && m.details?.usage) add(m.details.usage, m.details.usage.cost);
      else if (m.role === 'compactionSummary' && m.usage) add(m.usage, m.cost);
    }
    return sum;
  }

  _recomputeUsage() {
    const s = this._usageOf(this.messages);
    const d = this.dropped;
    this.usage = { input: s.input + d.input, output: s.output + d.output, cacheRead: s.cacheRead + d.cacheRead, cacheWrite: s.cacheWrite + d.cacheWrite };
    this.cost = s.cost + d.cost;
    this.costKnown = s.costKnown || d.cost > 0;
  }

  /** USD for one usage record: the provider's own figure when it sends one (OpenRouter), else catalog prices. */
  _costOf(usage, info = this.meta?.info) {
    if (Number.isFinite(usage?.costUsd)) return usage.costUsd;
    if (!info) return undefined;
    const c = costOf(info, usage);
    return Number.isFinite(c) ? c : undefined;
  }

  _modelName(id) {
    return this.models?.find((x) => x.id === id && (!this.provider || x.provider === this.provider))?.name || id;
  }

  /** Context window, thinking levels and prices of the current model (from the catalog when it exists). */
  async _refreshMeta(emit = true) {
    await catalogReady();
    const info = (this.provider && this.model && modelInfo(this.provider, this.model)) || null;
    const all = this.provider && this.model ? providers.thinkingLevels(this.provider, this.model) : [];
    const levels = [...new Set(all.map(String).filter((x) => x && x !== 'off'))];
    const type = this.config.type(this.provider);
    this.meta = { info, levels, contextWindow: info?.contextWindow || (type === 'anthropic' ? 200000 : 128000), contextWindowKnown: !!info?.contextWindow };
    if (this.thinkingLevel !== 'off' && !levels.includes(this.thinkingLevel) && this.provider) {
      const prev = this.thinkingLevel;
      this.thinkingLevel = levels.includes('medium') ? 'medium' : levels[levels.length - 1] || 'off';
      if (emit && prev !== this.thinkingLevel) this._emit({ type: 'thinking_level_changed', level: this.thinkingLevel });
    }
    return this.meta;
  }

  _maxTokens() {
    const mo = this.meta?.info?.maxOutput;
    return mo ? Math.min(mo, 32000) : undefined;
  }

  /** false only when the catalog says the model cannot take images (unknown models are assumed to). */
  _vision() {
    return this.meta?.info?.vision !== false;
  }

  async _setThinking(level) {
    await this._refreshMeta(false);
    const levels = this.meta?.levels || [];
    if (level !== 'off' && !levels.includes(level)) throw new Error(levels.length ? `Thinking level must be one of: off, ${levels.join(', ')}` : 'This model has no thinking levels');
    this.thinkingLevel = level;
    if (this.session) this._persistRaw({ type: 'thinking', level });
    this._emit({ type: 'thinking_level_changed', level });
    return level;
  }

  async _setModel(provider, modelId) {
    if (provider) {
      if (!this.config.configured(provider)) throw new Error(`${this.config.provider(provider)?.name || provider} is not set up. Add it in Settings → AI providers.`);
      this.provider = provider;
    }
    this.model = modelId;
    await this._refreshMeta(true);
    if (this.session) this._persistRaw({ type: 'model', provider: this.provider, model: this.model });
    this._emit({ type: 'model_changed', model: { id: this.model, provider: this.provider } });
  }

  async _models() {
    if (this.models) return this.models;
    const ids = this.config.configuredIds();
    if (!ids.length) throw new Error('No AI provider is set up yet. Open Settings → AI providers and add an API key.');
    await catalogReady();
    const results = await Promise.allSettled(
      ids.map(async (id) => {
        const list = await providers.clientFor(this.config.type(id)).listModels({ apiKey: await this.config.getKey(id), baseUrl: this.config.baseUrl(id) });
        return list.map((m) => {
          const info = modelInfo(id, m.id);
          const levels = providers.thinkingLevels(id, m.id).filter((x) => x && x !== 'off');
          return { id: m.id, provider: id, name: m.name, reasoning: levels.length > 0, input: info?.vision === false ? ['text'] : ['text', 'image'], contextWindow: info?.contextWindow, maxTokens: info?.maxOutput, cost: info?.cost, thinking: levels.length ? { efforts: levels, mode: 'effort' } : undefined };
        });
      }),
    );
    const good = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    if (!good.length) throw results.find((r) => r.status === 'rejected').reason;
    // A provider that failed to answer is reported, never silently dropped.
    results.forEach((r, i) => r.status === 'rejected' && this._emit({ type: 'notice', level: 'warn', message: `${this.config.provider(ids[i]).name}: could not load models (${r.reason?.message || r.reason})` }));
    this.models = good;
    return good;
  }

  async _resolveModel() {
    // A known provider + model needs no model list: listing every provider first would delay the first token.
    if (this.model && this.provider && this.config.configured(this.provider)) return this._refreshMeta(true);
    const models = await this._models();
    if (this.model) {
      const hit = models.find((m) => m.id === this.model && (!this.provider || m.provider === this.provider)) || models.find((m) => m.id === this.model);
      this.provider = hit?.provider || this.provider || this.config.configuredIds()[0];
    } else {
      const first = (this.provider && models.find((m) => m.provider === this.provider)) || models[0];
      this.provider = first.provider;
      this.model = first.id;
    }
    await this._refreshMeta(true);
  }

  /** Everything needed to call the current model. `stream(args)` fills in key, URL, model and thinking. */
  async _connect() {
    await this._resolveModel();
    const providerInfo = this.config.provider(this.provider);
    if (!providerInfo) throw new Error(`Unknown provider "${this.provider}". Pick a model again.`);
    const key = await this.config.getKey(this.provider);
    if (!key && !providerInfo.keyOptional) throw new Error(`No API key is saved for ${providerInfo.name}. Open Settings → AI providers.`);
    const client = providers.clientFor(providerInfo.type);
    const base = { apiKey: key, baseUrl: this.config.baseUrl(this.provider), model: this.model, providerId: this.provider, maxTokens: this._maxTokens() };
    const thinking = this.thinkingLevel !== 'off' ? this.thinkingLevel : undefined;
    const args = (a) => ({ ...base, thinking, ...a });
    const main = { client, args, stream: (a) => client.stream(args(a)), provider: this.provider, model: this.model, info: this.meta?.info || null, contextWindow: this.meta?.contextWindow, thinking };
    // Plan mode thinks with the "plan" model when one is chosen (Settings → AI providers → Models, or /model plan).
    if (this.planMode) return (await this._roleConnSafe('plan')) || main;
    return main;
  }

  /** "provider/model" chosen for a role: this session's override, else the saved default, else '' (current model). */
  _roleSpec(role) {
    return this.roles[role] || this.config.roles?.()?.[role] || '';
  }

  /** A connection for a role's model, or null when no model is chosen for it. Throws a plain error when it cannot be used. */
  async _roleConn(role) {
    const spec = this._roleSpec(role);
    if (!spec) return null;
    const label = role === 'fast' ? 'fast' : 'plan';
    const s = this._parseSpec(spec);
    const provider = s.provider || this.provider;
    const info = this.config.provider(provider);
    if (!info) throw new Error(`The ${label} model "${spec}" has no provider. Choose it again in Settings → AI providers → Models.`);
    if (!this.config.configured(provider)) throw new Error(`The ${label} model "${spec}" needs ${info.name}, which is not set up. Add it in Settings → AI providers, or choose another ${label} model.`);
    const key = await this.config.getKey(provider);
    if (!key && !info.keyOptional) throw new Error(`No API key is saved for ${info.name} (the ${label} model). Open Settings → AI providers.`);
    await catalogReady();
    const mi = modelInfo(provider, s.model) || null;
    const levels = providers.thinkingLevels(provider, s.model).filter((x) => x && x !== 'off');
    const thinking = this.thinkingLevel !== 'off' && levels.includes(this.thinkingLevel) ? this.thinkingLevel : undefined;
    const client = providers.clientFor(info.type);
    const base = { apiKey: key, baseUrl: this.config.baseUrl(provider), model: s.model, providerId: provider, maxTokens: mi?.maxOutput ? Math.min(mi.maxOutput, 32000) : undefined };
    const args = (a) => ({ ...base, thinking, ...a });
    return { client, args, stream: (a) => client.stream(args(a)), provider, model: s.model, info: mi, contextWindow: mi?.contextWindow || (info.type === 'anthropic' ? 200000 : 128000), thinking, role };
  }

  /** Like _roleConn, but a role that cannot be used is reported once as a note and the caller falls back to the current model. */
  async _roleConnSafe(role) {
    try {
      return await this._roleConn(role);
    } catch (e) {
      const key = `${role}:${e.message}`;
      if (this._roleWarned !== key) {
        this._roleWarned = key;
        this._emit({ type: 'notice', level: 'warn', message: `${e.message} Using the current model instead.` });
      }
      return null;
    }
  }

  /** Set (or clear, with '' / 'default') this session's fast or plan model. Returns the text to show. */
  async _setRole(role, arg) {
    const name = role === 'fast' ? 'Fast' : 'Plan';
    const text = String(arg || '').trim();
    const where = () => {
      const own = this.roles[role];
      const saved = this.config.roles?.()?.[role] || '';
      return own ? `**${own}** (this session)` : saved ? `**${saved}** (default from Settings)` : `not set: the current model is used`;
    };
    if (!text) return `${name} model: ${where()}. Change it with \`/model ${role} provider/model-id\`, or \`/model ${role} default\` to go back to the Settings default.`;
    if (/^(default|reset|clear|none|off)$/i.test(text)) {
      this.roles[role] = '';
    } else {
      const spec = this._parseSpec(text);
      const models = await this._models().catch((e) => {
        throw new Error(`Could not check the model list: ${e.message}`);
      });
      const hit = models.find((x) => x.id === spec.model && (!spec.provider || x.provider === spec.provider)) || (!spec.provider ? models.find((x) => x.id === text) : null);
      if (!hit) throw new Error(`No model "${text}". Use provider/model-id (for example anthropic/claude-haiku-4-5) from the model picker.`);
      this.roles[role] = `${hit.provider}/${hit.id}`;
    }
    this._persistRaw({ type: 'roles', fast: this.roles.fast, plan: this.roles.plan });
    this._roleWarned = null;
    return `${name} model is now ${where()}.`;
  }

  _isReadOnly(name) {
    return READ_ONLY.has(name) || this.mcp.isReadOnly(name);
  }

  _needsApproval(name) {
    return NEEDS_APPROVAL.has(name) || (this.mcp.has(name) && !this.mcp.isReadOnly(name));
  }

  /** web_search is offered to the model only when a search service is set up. */
  _searchOn() {
    return !!this.config.searchReady?.();
  }

  _toolDefs() {
    const defs = [...this.defs.filter((d) => d.name !== 'web_search' || this._searchOn()), ...this.mcp.toolDefs()];
    return this.planMode ? defs.filter((d) => this._isReadOnly(d.name)) : defs;
  }

  _emit(ev) {
    this.emit('event', ev);
  }

  _persist(message) {
    if (this.opts.noSession) return;
    this._ensureSession();
    appendEntry(this.session.file, { type: 'message', message });
  }

  _persistRaw(entry) {
    if (this.opts.noSession) return;
    this._ensureSession();
    appendEntry(this.session.file, entry);
  }

  _ensureSession() {
    if (this.session) return;
    this.session = createSession({ cwd: this.workspace, keyPath: this.backend.keyPath(this.workspace), model: this.model, provider: this.provider });
    this.sessionId = this.session.id;
    if (this.thinkingLevel !== 'off') appendEntry(this.session.file, { type: 'thinking', level: this.thinkingLevel });
    if (this.planMode) appendEntry(this.session.file, { type: 'plan', on: true });
  }

  /** Add a message to the conversation: memory, session file, UI. */
  _add(message) {
    this.messages.push(message);
    this._persist(message);
    this._emit({ type: 'message_start', message });
    this._emit({ type: 'message_end', message });
    return message;
  }

  _pushUser(text, images, attribution = 'user', attachments = []) {
    const user = { role: 'user', id: uid('u'), content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType || 'image/png' }))], attribution, timestamp: Date.now() };
    if (attachments.length) user.attachments = attachments;
    return this._add(user);
  }

  /** Mentioned files: images go in as images, everything else as attachments. */
  async _mentions(text) {
    const found = await readMentions(this.backend, this.workspace, text).catch(() => []);
    return { images: found.filter((a) => a.image).map((a) => a.image), attachments: found.filter((a) => !a.image) };
  }

  async _drainSteer() {
    while (this.queue.steer.length) {
      const q = this.queue.steer.shift();
      const men = await this._mentions(q.text);
      this._pushUser(q.text, [...q.images, ...men.images], q.attribution === 'command' ? 'command' : 'steer', [...(q.attachments || []), ...men.attachments]);
    }
  }

  /** Run `fn` as one agent activity: streaming flag, agent_start/agent_end with a summary, errors, then queued follow-ups. */
  async _exclusive(fn) {
    this.streaming = true;
    this.abortCtl = new AbortController();
    const run = (this.run = { startedAt: Date.now(), status: 'completed', stopReason: 'stop', errorMessage: null, turns: 0, toolCalls: 0, from: this.messages.length });
    this._emit({ type: 'agent_start' });
    try {
      await fn();
    } catch (e) {
      const msg = e?.message || String(e);
      run.status = 'error';
      run.stopReason = 'error';
      run.errorMessage = msg;
      this._add({ role: 'assistant', content: [], provider: this.provider, model: this.model, stopReason: 'error', errorMessage: msg, timestamp: Date.now() });
      this._emit({ type: 'notice', level: 'error', message: msg });
    } finally {
      const aborted = this.abortCtl?.signal.aborted;
      if (aborted) {
        run.status = 'aborted';
        run.stopReason = 'aborted';
      }
      this.streaming = false;
      const spent = this._usageOf(this.messages.slice(run.from));
      const summary = {
        status: run.status,
        stopReason: run.stopReason,
        ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
        durationMs: Date.now() - run.startedAt,
        turns: run.turns,
        toolCalls: run.toolCalls,
        usage: { input: spent.input, output: spent.output, cacheRead: spent.cacheRead, cacheWrite: spent.cacheWrite },
        ...(spent.costKnown ? { cost: spent.cost } : {}),
      };
      this.run = null;
      if (this.goal) this._goalStep(run, aborted);
      this._emit({ type: 'agent_end', isTerminal: true, messages: this.messages, ...summary });
      this._emit({ type: 'prompt_result', agentInvoked: true, sessionSettled: true, ...summary });
      this._emit({ type: 'session_settled' });
      // Stopping drops what was queued; otherwise steers that arrived after the last step (or during a compaction)
      // run next, then queued follow-ups. A prompt that started meanwhile picks the queue up itself.
      if (aborted) {
        this.queue.steer.length = 0;
        this.queue.followUp.length = 0;
      } else if (this.queue.steer.length || this.queue.followUp.length) {
        setImmediate(() => {
          if (this.exited || this.streaming) return;
          const next = this.queue.steer.shift() || this.queue.followUp.shift();
          if (next) this._run(next.text, next.images, next.attribution, next.attachments).catch((e) => this.emit('stderr', String(e?.stack || e)));
        });
      }
    }
  }

  _run(text, images, attribution = 'user', attachments = []) {
    return this._exclusive(async () => {
      // Hooks may stop a message you typed before the agent sees it.
      if (attribution === 'user') {
        if (this.goal) this._endGoal('Goal mode ended because you sent a message.');
        const hk = await this.hooks.run('UserPromptSubmit', { input: { prompt: text } }, this.abortCtl.signal);
        if (hk.blocked) {
          this._emit({ type: 'notice', level: 'warn', message: `A hook blocked this message: ${hk.reason}` });
          return;
        }
      } else if (attribution === 'goal') this.run.goalRound = this.goal?.round || 1;
      // Model connection, MCP servers and the system prompt's parts are prepared while the message is recorded.
      const prep = Promise.all([this._connect(), this.mcp.ensureStarted().catch((e) => this._emit({ type: 'notice', level: 'warn', message: `MCP: ${e.message}` })), this._envFacts()]);
      prep.catch(() => {});
      const men = await this._mentions(text);
      this._pushUser(text, [...images, ...men.images], attribution, [...attachments, ...men.attachments]);
      if (!this.title) {
        this.title = makeTitle(attribution === 'goal' && this.goal ? this.goal.text : text) || (attachments[0]?.path ? makeTitle(attachments[0].path) : '') || 'New session';
        this._persistRaw({ type: 'title', title: this.title });
        this._aiTitle(this.title, attribution === 'goal' && this.goal ? this.goal.text : text).catch(() => {});
      }
      const [conn] = await prep;
      await this._loop(conn);
    });
  }

  /** The agent loop from the current conversation: model turn, tools, repeat until the model stops. */
  async _loop(conn) {
    const run = this.run;
    const system = await this._system();
    const once = { compacted: false, overflow: false, empty: false, midStream: false, continued: false, stop: false };
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      await this._drainSteer();
      if (this.abortCtl.signal.aborted) break;
      if (this.autoCompact && !once.compacted && this._overThreshold(conn.contextWindow, conn.args?.({}).maxTokens ?? 8192)) {
        once.compacted = true;
        await this._compact({ conn, reason: 'threshold' });
        if (this.abortCtl.signal.aborted) break;
      }
      this._emit({ type: 'turn_start' });
      run.turns++;
      const asst = await this._streamAssistant({ conn, system, retryEmpty: !once.empty, retryError: !once.midStream });
      const calls = asst.content.filter((c) => c.type === 'toolCall');
      const end = (results = []) => this._emit({ type: 'turn_end', message: asst, toolResults: results });
      if (asst.stopReason === 'error' && !once.overflow && isOverflow(asst.errorMessage)) {
        once.overflow = true;
        end();
        if (await this._compact({ conn, reason: 'overflow' })) continue;
        run.status = 'error';
        run.stopReason = 'error';
        run.errorMessage = asst.errorMessage;
        break;
      }
      if (asst.discard) {
        // A connection that broke mid-reply, or an empty reply: try the turn once more.
        end();
        if (asst.discardReason === 'empty') once.empty = true;
        else {
          once.midStream = true;
          this._emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 2, delayMs: MID_STREAM_RETRY_MS, errorMessage: asst.errorMessage });
          await sleep(MID_STREAM_RETRY_MS, this.abortCtl.signal);
          this._emit({ type: 'auto_retry_end', success: !this.abortCtl.signal.aborted });
        }
        turn--;
        continue;
      }
      if (asst.stopReason === 'aborted' || asst.stopReason === 'error') {
        end();
        if (asst.stopReason === 'error') Object.assign(run, { status: 'error', stopReason: 'error', errorMessage: asst.errorMessage });
        break;
      }
      if (asst.refusal) {
        end();
        run.stopReason = 'refusal';
        this._emit({ type: 'notice', level: 'warn', message: 'The model declined to answer this request.' });
        break;
      }
      if (!calls.length) {
        end();
        if (asst.stopReason === 'length' && !once.continued) {
          once.continued = true;
          this._add({ role: 'custom', customType: 'continue', forModel: true, display: true, content: [{ type: 'text', text: CONTINUE_TEXT }], timestamp: Date.now() });
          continue;
        }
        if (!hasAnswer(asst)) {
          run.stopReason = 'empty';
          this._emit({ type: 'notice', level: 'warn', message: 'The model returned an empty reply. Send the message again, or try another model.' });
          break;
        }
        run.stopReason = asst.stopReason === 'length' ? 'length' : 'stop';
        if (run.stopReason === 'length') this._emit({ type: 'notice', level: 'warn', message: 'The reply was cut off by the output token limit again. Ask the agent to continue, or to answer in shorter parts.' });
        if (this.queue.steer.length) continue;
        if (!once.stop && run.stopReason === 'stop') {
          // A Stop hook can ask the agent to carry on (once per run, so it cannot loop forever).
          once.stop = true;
          const hk = await this.hooks.run('Stop', { extra: { stop_hook_active: false } }, this.abortCtl.signal);
          if (hk.blocked) {
            this._add({ role: 'custom', customType: 'hook', forModel: true, display: true, content: [{ type: 'text', text: `A Stop hook asks you to continue: ${hk.reason}` }], timestamp: Date.now() });
            continue;
          }
        }
        break;
      }
      if (asst.stopReason === 'length') for (const c of calls) c.truncated = true;
      run.toolCalls += calls.length;
      const results = await this._runTools(calls, conn);
      end(results);
      if (this.abortCtl.signal.aborted) break;
      if (turn === MAX_TURNS - 1) {
        run.stopReason = 'max_turns';
        this._emit({ type: 'notice', level: 'warn', message: `Stopped after ${MAX_TURNS} steps. Send a message to continue.` });
      }
    }
  }

  _overThreshold(cw = this.meta?.contextWindow, reserve = this._maxTokens() ?? 8192) {
    return !!cw && contextTokens(this.messages) > compactLimit(cw, reserve);
  }

  /** The environment block, captured once per session so the system prompt stays byte-identical (prompt cache). */
  _envFacts() {
    if (!this.envFacts) this.envFacts = environmentFacts(this.backend, this.workspace).catch((e) => {
      this.envFacts = null;
      throw e;
    });
    return this.envFacts;
  }

  async _system({ subagent = false, tools } = {}) {
    const [env, rules, skills] = await Promise.all([this._envFacts().catch(() => ({ workspace: this.workspace, shell: this.backend.isWsl ? 'bash in WSL' : 'Windows cmd.exe', os: 'Windows', date: new Date().toISOString().slice(0, 10), git: null })), loadInstructions(this.backend, this.workspace).catch(() => []), subagent ? [] : this._skills()]);
    const model = this.model ? `${this.provider ? this.provider + '/' : ''}${this.model}` : '';
    if (subagent) return subagentPrompt(buildSystemPrompt({ env, model, approvals: null, rules }), tools);
    return buildSystemPrompt({ env, model, approvals: this.config.data.approvals, rules, skills: skillsPrompt(skills), mcp: this.mcp.instructionsText(), planMode: this.planMode });
  }

  _skills() {
    const host = this.backend.hostPath(this.workspace);
    const join = (root, rel) => (isWinPath(root) ? path.win32.join(root, rel) : path.posix.join(root, rel));
    return discoverSkills({ hostRoot: host, displayRoot: this.workspace, join }).catch(() => []);
  }

  /** What the provider sees: compacted context; images become notes for a model without vision. */
  _context() {
    // Colour codes kept in bash output for the UI cost tokens and mean nothing to the model.
    const msgs = contextMessages(this.messages).map((m) => (m.role === 'toolResult' && m.content?.some((c) => c.type === 'text' && c.text.includes('\x1b')) ? { ...m, content: m.content.map((c) => (c.type === 'text' ? { ...c, text: stripSgr(c.text) } : c)) } : m));
    if (this._vision()) return msgs;
    const strip = (content) => (Array.isArray(content) && content.some((c) => c.type === 'image') ? content.map((c) => (c.type === 'image' ? { type: 'text', text: '[image not shown: the current model cannot view images]' } : c)) : content);
    return msgs.map((m) => (m.role === 'user' || m.role === 'toolResult' ? { ...m, content: strip(m.content) } : m));
  }

  /**
   * Stream one assistant turn into a message (shown live, then saved). With `retryEmpty` an empty reply, and with
   * `retryError` a reply whose connection broke mid-stream, is marked `discard` (kept for the record, not sent again).
   */
  async _streamAssistant({ conn, system, retryEmpty = false, retryError = false }) {
    const signal = this.abortCtl.signal;
    const msg = { role: 'assistant', content: [], api: this.config.type(conn.provider || this.provider), provider: conn.provider || this.provider, model: conn.model || this.model, usage: { ...zeroUsage(), totalTokens: 0 }, stopReason: 'stop', timestamp: Date.now() };
    if (conn.thinking) msg.thinkingLevel = conn.thinking;
    const asm = new TurnAssembler(msg);
    let lastEmit = 0;
    let retrying = false;
    const retryDone = (success, finalError) => {
      if (!retrying) return;
      retrying = false;
      this._emit({ type: 'auto_retry_end', success, ...(finalError ? { finalError } : {}) });
    };
    const update = (force, r) => {
      const now = Date.now();
      if (!force && now - lastEmit < 30) return;
      lastEmit = now;
      asm.refreshPartial(); // partial tool arguments are parsed only when a snapshot goes out
      this._emit({ type: 'message_update', message: structuredClone(msg), assistantMessageEvent: { type: r.kind, contentIndex: r.index, delta: r.delta } });
    };
    this._emit({ type: 'message_start', message: structuredClone(msg) });
    try {
      for await (const ev of conn.stream({ system, messages: this._context(), tools: this._toolDefs(), signal })) {
        if (ev.type === 'retry') {
          retrying = true;
          this._emit({ type: 'auto_retry_start', attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.reason });
          continue;
        }
        if (retrying && ev.type !== 'start' && ev.type !== 'usage') retryDone(true);
        const r = asm.push(ev);
        if (r) update(r.kind === 'toolcall_start' || r.kind === 'toolcall_end', r);
      }
      retryDone(true);
    } catch (e) {
      if (signal.aborted) msg.stopReason = 'aborted';
      else {
        msg.stopReason = 'error';
        msg.errorMessage = e?.message || String(e);
        retryDone(false, msg.errorMessage);
        if (retryError && e?.retryable && e?.midStream) {
          msg.discard = true;
          msg.discardReason = 'retry';
          msg.errorMessage += ' (retrying)';
        } else if (!isOverflow(msg.errorMessage)) this._emit({ type: 'notice', level: 'error', message: msg.errorMessage });
      }
      retryDone(false);
    }
    asm.finish();
    if (signal.aborted && msg.stopReason !== 'error') msg.stopReason = 'aborted';
    if (retryEmpty && msg.stopReason === 'stop' && !hasAnswer(msg)) {
      msg.discard = true;
      msg.discardReason = 'empty';
    }
    msg.usage.totalTokens = msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
    const cost = this._costOf(msg.usage, conn.info);
    if (cost !== undefined) msg.usage.cost = { total: cost };
    this._addUsage(msg.usage, cost);
    this.messages.push(msg);
    this._persist(msg);
    this._emit({ type: 'message_end', message: structuredClone(msg) });
    return msg;
  }

  /** Drop messages from `index` on (memory and session), optionally reverting their file changes first. */
  async _rewind(index, { undo = false } = {}) {
    const dropped = this.messages.slice(index);
    let undoText = '';
    if (undo) {
      const ids = dropped.filter((m) => m.role === 'toolResult' && this.checkpoints.has(m.toolCallId) && !this.undone.has(m.toolCallId)).map((m) => m.toolCallId).reverse();
      if (ids.length) undoText = (await this._undoIds(ids)).text;
    }
    const spent = this._usageOf(dropped);
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost']) this.dropped[k] += spent[k];
    this.messages.length = index;
    this._persistRaw({ type: 'rewind', count: index, dropped: { input: spent.input, output: spent.output, cacheRead: spent.cacheRead, cacheWrite: spent.cacheWrite, cost: spent.cost } });
    const callIds = new Set(dropped.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId));
    for (const [id, s] of this.subagents) if (callIds.has(s.parentToolCallId)) this.subagents.delete(id);
    this.todoPhases = [];
    for (const m of this.messages) if (m.role === 'toolResult' && m.toolName === 'todo' && m.details?.phases) this.todoPhases = m.details.phases;
    this._emit({ type: 'session_rewound', messageCount: this.messages.length, removed: dropped.length, ...(undoText ? { undo: undoText } : {}) });
    return { removed: dropped.length, ...(undoText ? { undo: undoText } : {}) };
  }

  _idle(what) {
    if (this.streaming) throw new Error(`Wait for the agent to finish (or stop it), then ${what}.`);
  }

  /** Answer the last user message again: its reply (and tool calls) are dropped and the model runs anew. */
  async _regenerate({ undo = false } = {}) {
    this._idle('regenerate');
    let i = this.messages.length - 1;
    while (i >= 0 && this.messages[i].role !== 'user') i--;
    if (i < 0) throw new Error('There is no message to answer again.');
    const r = await this._rewind(i + 1, { undo });
    this._exclusive(async () => {
      const conn = await this._connect();
      await this.mcp.ensureStarted().catch(() => {});
      await this._loop(conn);
    }).catch((e) => this.emit('stderr', String(e?.stack || e)));
    return r;
  }

  /**
   * Replace a user message (by `messageId`, `timestamp` or `index`; default: the last one the user typed) with a new
   * text and run from there. Everything after it is dropped.
   */
  async _editMessage(cmd) {
    this._idle('edit a message');
    const text = String(cmd.message ?? '');
    let i = -1;
    if (cmd.messageId) i = this.messages.findIndex((m) => m.role === 'user' && m.id === cmd.messageId);
    else if (Number.isFinite(cmd.timestamp)) i = this.messages.findIndex((m) => m.role === 'user' && m.timestamp === cmd.timestamp);
    else if (Number.isInteger(cmd.index)) i = this.messages[cmd.index]?.role === 'user' ? cmd.index : -1;
    else for (let k = this.messages.length - 1; k >= 0 && i < 0; k--) if (this.messages[k].role === 'user' && this.messages[k].attribution !== 'command') i = k;
    if (i < 0) throw new Error('That message was not found in this conversation.');
    if (i < lastMarker(this.messages)) throw new Error('That message is in the compacted part of the conversation and cannot be edited.');
    const { images, notes } = promptImages(cmd.images);
    const att = promptAttachments(cmd.attachments);
    if (!text.trim() && !images.length && !att.attachments.length && !att.images.length) throw new Error('Nothing to send');
    const r = await this._rewind(i, { undo: !!cmd.undo });
    for (const n of [...notes, ...att.notes]) this._emit({ type: 'notice', level: 'warn', message: n });
    this._run(text, [...images, ...att.images], 'user', att.attachments).catch((e) => this.emit('stderr', String(e?.stack || e)));
    return r;
  }

  async _compactCmd(focus) {
    const conn = await this._connect();
    await this._compact({ conn, reason: 'manual', focus });
  }

  /** Summarize older messages and insert a compaction marker. Returns true when something was compacted. */
  async _compact({ conn, reason, focus = '' }) {
    if (this.compacting) return false;
    this.compacting = true;
    this._emit({ type: 'auto_compaction_start', reason });
    let result = null;
    let error = null;
    try {
      const cw = this.meta?.contextWindow || 128000;
      let keep = Math.min(Math.floor(cw * 0.25), 60000);
      if (reason !== 'threshold') keep = Math.min(keep, Math.floor(estimateTokens(contextMessages(this.messages)) * 0.3));
      const cut = findCut(this.messages, Math.max(500, keep / tokenScale(this.messages)));
      if (cut < 0) throw new Error('Nothing to compact yet: the conversation is too short.');
      const from = Math.max(0, lastMarker(this.messages));
      const older = this.messages.slice(from, cut);
      const tokensBefore = contextTokens(this.messages);
      // Summaries are written by the fast model when one is chosen.
      const sconn = (await this._roleConnSafe('fast')) || conn;
      const { summary, usage } = await summarize({
        stream: (a) => sconn.stream({ ...a, thinking: undefined }),
        older,
        focus,
        contextWindow: Math.min(cw, sconn.contextWindow || cw),
        signal: this.abortCtl?.signal,
        onRetry: (ev) => this._emit({ type: 'auto_retry_start', attempt: ev.attempt, maxAttempts: ev.maxAttempts, delayMs: ev.delayMs, errorMessage: ev.reason }),
      });
      if (this.abortCtl?.signal.aborted) throw new Error('Stopped');
      const cost = this._costOf(usage, sconn.info);
      const marker = { role: 'compactionSummary', summary, tokensBefore, timestamp: Date.now(), usage, ...(cost !== undefined ? { cost } : {}) };
      const keptCount = this.messages.length - cut;
      this.messages.splice(cut, 0, marker);
      this._persistRaw({ type: 'compaction', summary, keptCount, tokensBefore, timestamp: marker.timestamp, usage, ...(cost !== undefined ? { cost } : {}) });
      this._addUsage(usage, cost);
      result = { summary, tokensBefore, tokensAfter: contextTokens(this.messages), firstKeptIndex: cut + 1 };
      return true;
    } catch (e) {
      error = this.abortCtl?.signal.aborted ? 'Stopped' : e?.message || String(e);
      this._emit({ type: 'notice', level: reason === 'manual' && /Nothing to compact/.test(error) ? 'info' : 'warn', message: `Compaction ${reason === 'manual' ? '' : '(automatic) '}did not run: ${error}` });
      return false;
    } finally {
      this.compacting = false;
      this._emit({ type: 'auto_compaction_end', reason, result, aborted: !result, ...(error ? { errorMessage: error } : {}) });
    }
  }

  /** Answer every open question with "cancelled" and close its dialog in the UI. */
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

  _askTitle(call) {
    const a = call.arguments || {};
    if (this.mcp.has(call.name)) return `Allow MCP tool ${this.mcp.describe(call.name)}?  ${clip(JSON.stringify(a), 200)}`;
    const detail = call.name === 'bash' ? `${a.shell === 'powershell' ? '[PowerShell] ' : ''}${a.command ?? ''}` : a.path;
    const verb = { bash: 'Run this command?', write: 'Write this file?', edit: 'Edit this file?' }[call.name] || `Allow ${call.name}?`;
    return `${verb}  ${clip(String(detail ?? ''), 200)}`;
  }

  /**
   * web_fetch on a private/local host: allowed when the user typed that host themselves (as a whole word, in a message
   * they wrote, not in an attached file or a command file), otherwise ask.
   */
  async _allowHost(host) {
    const h = host.toLowerCase();
    if (this.allowedHosts.has(h)) return true;
    if (userMentionsHost(this.messages, h)) return true;
    const ans = await this._askUser(`Fetch from ${host}? It is a local or private network address.`, ['Allow for this session', 'Deny']);
    if (ans === 'Allow for this session') {
      this.allowedHosts.add(h);
      return true;
    }
    return false;
  }

  /** Run tool calls: consecutive read-only calls run side by side, everything else one at a time, in order. */
  async _runTools(calls, conn) {
    const results = new Array(calls.length);
    let i = 0;
    while (i < calls.length && !this.abortCtl.signal.aborted) {
      if (this._isReadOnly(calls[i].name)) {
        let j = i;
        while (j < calls.length && this._isReadOnly(calls[j].name)) j++;
        const done = await Promise.all(calls.slice(i, j).map((c) => this._runTool(c, conn)));
        done.forEach((r, k) => (results[i + k] = r));
        i = j;
      } else {
        results[i] = await this._runTool(calls[i], conn);
        i++;
      }
    }
    // Every tool call must have a result, even when the run was stopped, or the next request would be invalid.
    for (let k = 0; k < calls.length; k++) if (!results[k]) results[k] = this._record(calls[k], { text: 'Not run: the agent was stopped before this step.', isError: true }, false);
    return results;
  }

  _record(call, result, announce = true, startedAt) {
    const content = [{ type: 'text', text: result.text }, ...(result.images || [])];
    const details = { ...(result.details || {}) };
    const undo = details.undo;
    delete details.undo;
    if (undo && !undo.skipped) {
      this.checkpoints.set(call.id, undo);
      this._persistRaw({ type: 'checkpoint', toolCallId: call.id, undo });
      details.undoable = true;
    }
    if (startedAt && details.wallTimeMs == null) details.wallTimeMs = Date.now() - startedAt;
    if (call.name === 'todo' && details.phases) this.todoPhases = details.phases;
    if (announce) this._emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content, details }, isError: !!result.isError });
    const tr = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content, details, isError: !!result.isError, timestamp: Date.now() };
    return this._add(tr);
  }

  async _runTool(call, conn) {
    const args = call.arguments || {};
    let t0 = Date.now();
    const intent = call.name === 'bash' ? clip(String(args.command ?? ''), 80) : call.name === 'web_fetch' ? clip(String(args.url ?? ''), 80) : this.mcp.has(call.name) ? this.mcp.describe(call.name) : undefined;
    this._emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args, intent });
    let result;
    if (call.truncated || call.invalidArguments) {
      result = call.truncated
        ? { text: 'Not run: this tool call was cut off because the reply reached the output token limit. Make smaller calls: for a large file, write the first part, then add the rest with edit.', isError: true }
        : { text: invalidArgsText(this._toolDefs().find((d) => d.name === call.name)), isError: true };
    } else if (this.planMode && !this._isReadOnly(call.name)) result = { text: 'Plan mode is on, so this tool is not available. Only read and plan; the user can turn plan mode off with /plan.', isError: true };
    else if ((!this.defs.some((d) => d.name === call.name) && !this.mcp.has(call.name)) || (call.name === 'web_search' && !this._searchOn())) result = { text: `Unknown tool "${call.name}". Available tools: ${this._toolDefs().map((d) => d.name).join(', ')}.`, isError: true };
    if (!result) {
      // PreToolUse hooks can stop a call before you are even asked about it.
      const hk = await this.hooks.run('PreToolUse', { tool: call.name, input: args }, this.abortCtl.signal);
      if (hk.blocked) result = { text: `Blocked by a hook: ${hk.reason}`, isError: true };
    }
    if (!result && this._needsApproval(call.name) && this.config.data.approvals === 'ask' && !this.allowAlways.has(call.name)) {
      const ans = await this._askUser(this._askTitle(call), ['Allow once', 'Allow for this session', 'Deny']);
      if (!ans || ans === 'Deny') result = { text: 'The user denied this action. Do not retry it; ask what they want instead.', isError: true };
      else if (ans === 'Allow for this session') this.allowAlways.add(call.name);
      t0 = Date.now(); // the run time counts from your answer, not the time the call waited for you
    }
    if (!result) {
      const onUpdate = (text) => this._emit({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args, partialResult: { content: [{ type: 'text', text }], details: {} } });
      if (call.name === 'task') result = await this._runTask(call, conn);
      else if (this.mcp.has(call.name)) result = await this.mcp.call(call.name, args, this.abortCtl?.signal);
      else result = await this.tools.run(call.name, args, { onUpdate, allowHost: (h) => this._allowHost(h), vision: this._vision(), search: () => this.config.searchConfig?.() });
      if (result.images?.length && !this._vision()) result = { ...result, images: undefined };
      // PostToolUse hooks can add feedback for the model (a failed check, a lint warning).
      if (!this.abortCtl.signal.aborted) {
        const hk = await this.hooks.run('PostToolUse', { tool: call.name, input: args, extra: { result: { text: clip(String(result.text ?? ''), 8000), isError: !!result.isError } } }, this.abortCtl.signal);
        if (hk.blocked) result = { ...result, text: `${result.text}\n[Hook feedback] ${hk.reason}` };
      }
    }
    return this._record(call, result, true, t0);
  }

  _goalStatus() {
    const g = this.goal;
    this._emit({ type: 'extension_ui_request', id: `status-goal-${Date.now()}`, method: 'setStatus', statusKey: 'goal', statusText: g ? `Goal ${g.round}/${g.max}: working (Esc to stop)` : '' });
  }

  /** Leave goal mode, with an optional note. */
  _endGoal(note = '') {
    if (!this.goal) return;
    this.goal = null;
    this._goalStatus();
    if (note) this._emit({ type: 'notice', level: 'info', message: note });
  }

  /** Start goal mode; returns the first request for the agent. */
  _startGoal(text) {
    this.goal = { text, round: 1, max: GOAL_ROUNDS };
    this._goalStatus();
    return goalPrompt(this.goal);
  }

  /**
   * After a goal round: GOAL_DONE on the last line ends it; a question to you pauses it; otherwise the next round is
   * queued as a follow-up (at most GOAL_ROUNDS rounds in all). Stopping or an error ends it.
   */
  _goalStep(run, aborted) {
    const g = this.goal;
    if (!run.goalRound || !g) return;
    if (aborted) return this._endGoal('Goal stopped.');
    if (run.status === 'error' || run.stopReason === 'error' || run.stopReason === 'refusal') return this._endGoal('Goal stopped because of an error. Fix it and run /goal again.');
    const last = [...this.messages].reverse().find((m) => m.role === 'assistant' && !m.discard);
    const lines = (last?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
    const end = lines[lines.length - 1] || '';
    if (/^[\W_]*GOAL_DONE[\W_]*$/.test(end)) return this._endGoal(`Goal reached after ${g.round} round${g.round === 1 ? '' : 's'}.`);
    if (/\?[\s*_)"'`]*$/.test(end)) return this._endGoal('Goal paused: the agent asked you a question. Answer it, or run /goal again to keep going.');
    if (g.round >= g.max) return this._endGoal(`Goal stopped after ${g.max} rounds without GOAL_DONE. Send a message to continue by hand.`);
    g.round++;
    this._emit({ type: 'notice', level: 'info', message: `Goal round ${g.round} of ${g.max}: still working (press Esc to stop).` });
    this._goalStatus();
    this.queue.followUp.push({ text: goalPrompt(g), images: [], attachments: [], attribution: 'goal' });
  }

  /**
   * Copy the conversation before a user message (`messageId`, or `index`; default: all of it) into a new saved
   * session. Files are not touched. The UI opens the new session in a tab when it gets `branch_created`.
   */
  _branch({ messageId, index } = {}) {
    if (!this.session || this.opts.noSession) throw new Error('This conversation is not saved yet. Send a message first, then branch.');
    let i = this.messages.length;
    if (messageId) i = this.messages.findIndex((m) => m.role === 'user' && m.id === messageId);
    else if (Number.isInteger(index)) i = index;
    if (i < 0 || i > this.messages.length) throw new Error('That message was not found in this conversation.');
    const title = `${(this.title || 'Conversation').replace(/(\s*\(branch\))+$/, '')} (branch)`;
    const r = branchSession(this.session.file, i, { title });
    const text = i < this.messages.length ? textOf(this.messages[i].content) : '';
    const out = { path: r.file, id: r.id, title, workspace: this.workspace, messages: r.count, text };
    this._emit({ type: 'branch_created', ...out });
    return out;
  }

  /** Replace the first-words title by a short model-written one. Only when a fast model is chosen; never the main model. */
  async _aiTitle(fallback, text) {
    if (!this._roleSpec('fast')) return;
    const conn = await this._roleConnSafe('fast');
    if (!conn) return;
    const msg = await collectTurn(conn.stream({ system: TITLE_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: clip(String(text), 1500) }], timestamp: Date.now() }], tools: [], signal: AbortSignal.timeout(20000), maxTokens: 40, thinking: undefined }));
    const t = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').slice(0, 60);
    this._addUsage(msg.usage, this._costOf(msg.usage, conn.info));
    if (!t || this.title !== fallback) return; // empty, or you renamed the session meanwhile
    this.title = t;
    this._persistRaw({ type: 'title', title: t });
    this._emit({ type: 'session_info_update', title: t });
  }

  async _runTask(call, conn) {
    const defs = this.defs.filter((d) => SUBAGENT_TOOLS.has(d.name) && (d.name !== 'web_search' || this._searchOn()));
    const last = new Map();
    const vision = this._vision();
    // Helper agents use the fast model when one is chosen.
    const sub = (await this._roleConnSafe('fast')) || conn;
    const r = await runTasks(call.arguments, {
      stream: sub.stream,
      system: await this._system({ subagent: true, tools: defs.map((d) => d.name) }),
      toolDefs: defs,
      model: sub.model,
      thinking: sub.thinking,
      signal: this.abortCtl.signal,
      parentToolCallId: call.id,
      idPrefix: `sub${++this.taskSeq}`,
      costOf: (u) => this._costOf(u, sub.info),
      invalidArgs: invalidArgsText,
      runTool: (c, signal) => this.tools.run(c.name, c.arguments || {}, { signal, allowHost: (h) => this._allowHost(h), vision, search: () => this.config.searchConfig?.() }),
      onUpdate: (view) => {
        const first = !this.subagents.has(view.id);
        const done = view.status !== 'running';
        const now = Date.now();
        if (!first && !done && now - (last.get(view.id) || 0) < 300) {
          this.subagents.set(view.id, { ...view, progress: view });
          return;
        }
        last.set(view.id, now);
        this.subagents.set(view.id, { ...view, progress: view });
        if (first) this._emit({ type: 'subagent_lifecycle', payload: { ...view } });
        this._emit({ type: 'subagent_progress', payload: { id: view.id, parentToolCallId: view.parentToolCallId, progress: view } });
        if (done) this._emit({ type: 'subagent_lifecycle', payload: { ...view } });
      },
    });
    if (r.details?.usage) this._addUsage(r.details.usage, r.details.usage.cost);
    return r;
  }

  async _undoIds(ids) {
    const lines = [];
    let ok = true;
    for (const id of ids) {
      if (this.undone.has(id)) {
        lines.push('Already undone.');
        continue;
      }
      const u = this.checkpoints.get(id);
      if (!u) {
        lines.push('No saved copy for this change.');
        ok = false;
        continue;
      }
      const r = await this.tools.undo(u);
      lines.push(r.text);
      if (r.ok) {
        this.undone.add(id);
        this._persistRaw({ type: 'undone', toolCallId: id });
        const m = this.messages.find((x) => x.role === 'toolResult' && x.toolCallId === id);
        if (m) m.details = { ...(m.details || {}), undone: true };
      } else ok = false;
    }
    return { ok, text: lines.join('\n') };
  }

  async _undoLastTurn() {
    let start = this.messages.length - 1;
    while (start >= 0 && this.messages[start].role !== 'user') start--;
    const ids = this.messages.slice(start + 1).filter((m) => m.role === 'toolResult' && this.checkpoints.has(m.toolCallId) && !this.undone.has(m.toolCallId)).map((m) => m.toolCallId).reverse();
    if (!ids.length) return { ok: true, text: 'Nothing to undo from the last reply.' };
    return this._undoIds(ids);
  }

  async _commands() {
    const [custom, skills] = await Promise.all([discoverCommands(this.backend.hostPath(this.workspace)).catch(() => []), this._skills()]);
    return [
      ...BUILTIN_COMMANDS.filter((c) => !(c.overridable && custom.some((x) => x.name.toLowerCase() === c.name))).map(({ overridable, ...c }) => ({ ...c, source: 'builtin' })),
      ...custom.map(({ file, ...c }) => c),
      ...skills.map((s) => ({ name: `skill:${s.name}`, description: s.description || `Use the ${s.name} skill`, source: 'skill', input: { hint: '[request]' } })),
    ];
  }

  _planStatus() {
    this._emit({ type: 'extension_ui_request', id: `status-plan-${Date.now()}`, method: 'setStatus', statusKey: 'plan', statusText: this.planMode ? 'Plan mode: read-only (/plan to leave)' : '' });
  }

  _out(text) {
    this._emit({ type: 'command_output', text });
  }

  async stop() {
    if (this.exited) return;
    this.goal = null;
    this.abortCtl?.abort();
    this.bashCtl?.abort();
    this._cancelAsks();
    this.exited = true;
    this.streaming = false;
    await this.mcp.stopAll().catch(() => {});
    if (this.session) closeSession(this.session.file);
    this.emit('exit', 0);
  }
}
