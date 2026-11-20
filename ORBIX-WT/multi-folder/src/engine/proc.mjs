// The ORBIX agent: one conversation's agent loop (model streaming, tools, approvals, compaction, subagents, undo).
// The server and UI drive it through request()/send() and its event stream (JSON frames: get_state, prompt,
// agent_start/end, message_update, tool_execution_*, extension_ui_request).
// This file holds the lifecycle, the commands and the turn loop. The rest of the agent lives beside it, mixed into
// this class (mixin.mjs): proc-models.mjs (model, thinking, connections), proc-tools.mjs (tool calls, approvals),
// proc-checks.mjs (the check and review after a run) and proc-usage.mjs (tokens, cost, context fill).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { clip, makeTitle, uid, textOf } from '../util.mjs';
import { isWinPath } from '../backend.mjs';
import * as providers from './providers.mjs';
import { NEEDS_APPROVAL, READ_ONLY, createTools, toolDefsFor, invalidArgsText } from './tools.mjs';
import { createSession, appendEntry, closeSession, loadSession, repairTail, branchSession } from './store.mjs';
import { loadInstructions, readMentions, promptAttachments, promptImages, loadUserInstructions } from './context.mjs';
import { compactLimit, contextMessages, contextTokens, estimateTokens, findCut, isOverflow, lastMarker, rebuildSession, summarize, tokenScale } from './compact.mjs';
import { runTasks, SUBAGENT_TOOLS } from './subagent.mjs';
import { TurnAssembler, collectTurn } from './assemble.mjs';
import { HookRunner } from './hooks.mjs';
import { stripSgr } from './files.mjs';
import { buildSystemPrompt, environmentFacts, subagentPrompt } from './prompt.mjs';
import { McpManager } from './mcp.mjs';
import { discoverSkills, skillsPrompt } from './skills.mjs';
import { BUILTIN_COMMANDS, discoverCommands } from './commands.mjs';
import { runSlash } from './slash.mjs';
import { UsageAccounting, zeroUsage } from './proc-usage.mjs';
import { ModelChoice } from './proc-models.mjs';
import { RunChecks } from './proc-checks.mjs';
import { ToolRuns, userMentionsHost } from './proc-tools.mjs';
import { mixin } from './mixin.mjs';
import { writeExport } from './export.mjs';
import { ARTIFACT_DEF, runPrompt } from './artifact.mjs';

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
/** Optional protocol features this engine supports (the UI shows the matching actions). */
const FEATURES = ['regenerate', 'edit_message', 'attachments', 'prompt_status', 'branch'];
const GOAL_ROUNDS = 6;
const TITLE_SYSTEM = 'You name chat sessions. Reply with only a title of at most 6 words for the conversation that starts with the message below: no quotes, no trailing punctuation, same language as the message.';



const hasAnswer = (m) => m.content.some((c) => (c.type === 'text' && c.text.trim()) || c.type === 'toolCall');
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
  constructor({ id, backend, workspace, resume, model, noSession, config, worktree, folders }) {
    super();
    this.id = id;
    this.backend = backend;
    this.workspace = workspace;
    // The project's extra folders (an array, or a function returning the current list): the agent reads and edits
    // there with the same approval rules as in `workspace`, which stays where relative paths and commands start.
    this.folders = typeof folders === 'function' ? folders : () => (Array.isArray(folders) ? folders : []);
    // A session on its own branch: { repo, slug, path, branch, base, baseBranch, source } (see gitapi.worktreeAdd).
    this.worktree = worktree || null;
    this.worktreeState = null; // { state: 'merged' | 'kept' | 'discarded', hash, at } once you reviewed it
    this.opts = { resume, model, noSession };
    this.config = config;
    this.exited = false;
    this.streaming = false;
    this.compacting = false;
    this.stderrTail = [];
    this.startedAt = Date.now();
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
    this.thinkingChosen = false; // until you choose a level, the session follows each model's own default
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
    // Set by the run controller when this conversation works on a run: { id, phase(), writeArtifact(args) }.
    this.runInfo = null;
    this.envFacts = null; // environment block of the system prompt, captured once (stable prefix for caching)
    this.defs = toolDefsFor(backend);
    this.tools = createTools({ backend, cwd: workspace, folders: () => this.folders(), getSignal: () => this.abortCtl?.signal });
    this.consoleTools = createTools({ backend, cwd: workspace, folders: () => this.folders(), getSignal: () => this.bashCtl?.signal });
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
      if (s.header.worktree) this.worktree = s.header.worktree;
      this.worktreeState = s.worktreeState || null;
      if (this.worktreeState?.state === 'discarded') throw new Error(`This session worked on ${this.worktree?.branch || 'its own branch'}, which was discarded with its folder, so it cannot be opened again.`);
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
      if (ex.thinkingLevel) (this.thinkingLevel = ex.thinkingLevel), (this.thinkingChosen = true);
      if (ex.roles) this.roles = { fast: ex.roles.fast || '', plan: ex.roles.plan || '' };
      this.planMode = ex.planMode;
      this.dropped = { ...zeroUsage(), cost: 0, ...ex.droppedUsage };
      this._recomputeUsage();
    }
    this._envFacts().catch(() => {}); // warm up (git status) while the user types
    await this._refreshMeta(false).catch(() => {});
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
      case 'set_model': {
        if (!cmd.modelId) throw new Error('modelId is required');
        await this._setModel(cmd.provider, cmd.modelId);
        return ok({});
      }
      case 'set_thinking_level':
        return ok({ level: await this._setThinking(String(cmd.level || 'off')) });
      case 'compact': {
        if (this.streaming) throw new Error('Wait for the agent to finish (or stop it), then compact.');
        this._exclusive(() => this._compactCmd(cmd.customInstructions || cmd.focus || '')).catch((e) => this.emit('stderr', String(e?.stack || e)));
        return ok({});
      }
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
          thinking: meta.levels?.length ? { efforts: meta.levels, mode: 'effort', canOff: meta.canOff !== false } : undefined,
        }
      : null;
    return {
      model: m,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.streaming,
      turnStartedAt: this.streaming ? this.run?.startedAt || null : null,
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
      worktree: this.worktreeView(),
      features: FEATURES,
    };
  }

  _isReadOnly(name) {
    return READ_ONLY.has(name) || name === 'artifact' || this.mcp.isReadOnly(name);
  }

  _needsApproval(name) {
    return NEEDS_APPROVAL.has(name) || (this.mcp.has(name) && !this.mcp.isReadOnly(name));
  }

  /** web_search is offered to the model only when a search service is set up. */
  _searchOn() {
    return !!this.config.searchReady?.();
  }

  _toolDefs() {
    const defs = [...this.defs.filter((d) => d.name !== 'web_search' || this._searchOn()), ...(this.runInfo ? [ARTIFACT_DEF] : []), ...this.mcp.toolDefs()];
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
    this.session = createSession({ cwd: this.workspace, keyPath: this.backend.keyPath(this.workspace), model: this.model, provider: this.provider, worktree: this.worktree || undefined });
    this.sessionId = this.session.id;
    if (this.thinkingLevel !== 'off') appendEntry(this.session.file, { type: 'thinking', level: this.thinkingLevel });
    if (this.planMode) appendEntry(this.session.file, { type: 'plan', on: true });
  }

  /** The branch of a session on its own branch, for the UI (null otherwise). */
  worktreeView() {
    if (!this.worktree) return null;
    const { branch, baseBranch, base, slug, source } = this.worktree;
    return { branch, baseBranch, base, slug, source, state: this.worktreeState?.state || '', hash: this.worktreeState?.hash || '' };
  }

  /** Record what you did with the branch (merged, kept, discarded): in the session file and in every open window. */
  setWorktreeState(state, extra = {}) {
    if (!this.worktree) return;
    this.worktreeState = { state, hash: extra.hash || '', at: Date.now() };
    if (this.session && !this.opts.noSession) appendEntry(this.session.file, { type: 'worktree', ...this.worktreeState });
    this._emit({ type: 'worktree_update', worktree: this.worktreeView() });
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
    const work = this._runExclusive(fn);
    this._activity = work;
    try {
      return await work;
    } finally {
      if (this._activity === work) this._activity = null;
    }
  }

  async _runExclusive(fn) {
    this.streaming = true;
    this.abortCtl = new AbortController();
    const run = (this.run = { startedAt: Date.now(), status: 'completed', stopReason: 'stop', errorMessage: null, turns: 0, toolCalls: 0, from: this.messages.length, edits: [], checks: {} });
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
        ...(run.checks.verify || run.checks.review ? { checks: { ...(run.checks.verify ? { verify: run.checks.verify } : {}), ...(run.checks.review ? { review: run.checks.review } : {}) } } : {}),
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
    const once = { compactions: 0, overflow: false, empty: false, midStream: false, continued: false, stop: false };
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      await this._drainSteer();
      if (this.abortCtl.signal.aborted) break;
      // A long run can pass the threshold again after a compaction; three per run is the limit, so a compaction that
      // cannot bring the context down does not repeat every turn.
      if (this.autoCompact && once.compactions < 3 && this._overThreshold(conn.contextWindow, conn.args?.({}).maxTokens ?? 8192)) {
        once.compactions++;
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
        // After edits, the project's check and a review of the diff; what they find gives the model another round.
        if (run.stopReason === 'stop' && (await this._finishChecks(conn))) continue;
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
      // Only the last call can be cut off by the token limit; the complete calls before it run as usual.
      if (asst.stopReason === 'length' && calls.at(-1).invalidArguments) calls.at(-1).truncated = true;
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

  /** Edits of the current run that are still in place, oldest first. */
  _overThreshold(cw = this.meta?.contextWindow, reserve = this._maxTokens() ?? 8192) {
    return !!cw && contextTokens(this.messages) > compactLimit(cw, reserve);
  }

  /** The environment block, captured once per session so the system prompt stays byte-identical (prompt cache). */
  _envFacts() {
    if (!this.envFacts) this.envFacts = environmentFacts(this.backend, this.workspace, { folders: this.folders(), worktree: !!this.worktree }).catch((e) => {
      this.envFacts = null;
      throw e;
    });
    return this.envFacts;
  }

  async _system({ subagent = false, tools } = {}) {
    const [env, rules, skills] = await Promise.all([this._envFacts().catch(() => ({ workspace: this.workspace, folders: this.folders(), worktree: !!this.worktree, shell: this.backend.isWsl ? 'bash in WSL' : 'Windows cmd.exe', os: 'Windows', date: new Date().toISOString().slice(0, 10), git: null })), Promise.all([loadInstructions(this.backend, this.workspace).catch(() => []), loadUserInstructions().catch(() => null)]).then(([own, mine]) => (mine ? [...own, mine] : own)), subagent ? [] : this._skills()]);
    const model = this.model ? `${this.provider ? this.provider + '/' : ''}${this.model}` : '';
    if (subagent) return subagentPrompt(buildSystemPrompt({ env, model, approvals: null, rules }), tools);
    // A run has its own phase instructions; the generic plan-mode text would contradict them.
    const base = buildSystemPrompt({ env, model, approvals: this.config.data.approvals, rules, skills: skillsPrompt(skills), mcp: this.mcp.instructionsText(), planMode: this.planMode && !this.runInfo });
    return this.runInfo ? `${base}\n\n${runPrompt({ phase: this.runInfo.phase(), branch: this.worktree?.branch, baseBranch: this.worktree?.baseBranch })}` : base;
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

  /**
   * Hold the session busy while `fn` runs (a rewind that restores files): a message sent meanwhile is queued as it is
   * during a run, instead of starting a second loop beside the one that follows.
   */
  async _held(fn) {
    this.streaming = true;
    try {
      return await fn();
    } finally {
      this.streaming = false;
    }
  }

  /** Answer the last user message again: its reply (and tool calls) are dropped and the model runs anew. */
  async _regenerate({ undo = false } = {}) {
    this._idle('regenerate');
    let i = this.messages.length - 1;
    while (i >= 0 && this.messages[i].role !== 'user') i--;
    if (i < 0) throw new Error('There’s no reply to regenerate yet.');
    const r = await this._held(() => this._rewind(i + 1, { undo }));
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
    const r = await this._held(() => this._rewind(i, { undo: !!cmd.undo }));
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
      // Helper agents go through the same PreToolUse / PostToolUse hooks as the main agent, so a hook that blocks
      // reading a file or fetching a host cannot be side-stepped with the task tool.
      runTool: (c, signal) => {
        const input = c.arguments || {};
        // A helper agent cannot ask you, so it does not reach outside the project unless approvals are Allow everything.
        if (this.config.data.approvals !== 'auto' && this._outside(c, input)) return { text: `Not run: ${input.path} is outside the project folder. Helper agents only read inside it; say in your answer that the main agent should read it.`, isError: true };
        return this._hooked(c.name, input, signal, { exec: () => this.tools.run(c.name, input, { signal, allowHost: (h) => this._allowHost(h), vision, search: () => this.config.searchConfig?.() }) });
      },
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

  async stop(ms = 2500) {
    if (this.exited) return;
    this.goal = null;
    this.abortCtl?.abort();
    this.bashCtl?.abort();
    this._cancelAsks();
    this.exited = true;
    // Let the current turn notice the abort and finish writing before the session file is closed.
    if (this._activity) {
      const cap = Number.isFinite(ms) && ms > 0 ? ms : 2500;
      await Promise.race([this._activity.catch(() => {}), new Promise((r) => setTimeout(r, cap))]);
    }
    this.streaming = false;
    await this.mcp.stopAll().catch(() => {});
    if (this.session) closeSession(this.session.file);
    this.emit('exit', 0);
  }
}

// The parts of an agent that live in their own files: token usage and cost; the model, thinking and connections; the
// checks at the end of a run; and running tool calls with their approvals.
mixin(AgentProc, UsageAccounting, ModelChoice, RunChecks, ToolRuns);

export { userMentionsHost }; // used by the tests and kept here for callers of proc.mjs
