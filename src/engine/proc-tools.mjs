// Running the model's tool calls: approvals (ask, allow always, trusted commands), hooks, paths outside the project,
// local network addresses, and recording each result. Part of AgentProc (see proc.mjs and mixin.mjs).
import path from 'node:path';
import { clip } from '../util.mjs';
import { invalidArgsText } from './tools.mjs';
import { isTrustedCommand, trustableCommand } from './store.mjs';
import { destructiveReason, catastrophicReason, siteVerdict, readOnlyCommand } from './policy.mjs';

// File tools whose path is checked against the project folder before they run.
const PATH_TOOLS = new Set(['read', 'grep', 'glob', 'write', 'edit']);

// The same call failing the same way with no other call between it: from the REPEAT_NOTE-th time the result tells the
// model to change course; from the REPEAT_BLOCK-th time it is not run at all (see _loop for when the run stops).
const REPEAT_NOTE = 3;
const REPEAT_BLOCK = 5;

/** JSON with object keys sorted, so two calls with the same arguments in another order compare equal. */
const stableJson = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** A call's identity: tool name and arguments. */
const callKey = (call) => `${call.name}\0${stableJson(call.arguments || {})}`;
/** An error text without its numbers (durations, timestamps), so two runs of one failure compare equal. */
const failureOf = (text) => String(text ?? '').replace(/\d+/g, '#').slice(0, 4000);

/** True when a message the user typed names `host` as a whole word ("10.0.0.1" does not match "10.0.0.15"). */
export function userMentionsHost(messages, host) {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w.-])${esc}(?![\\w-]|\\.\\w)`, 'i');
  return messages.some((m) => m.role === 'user' && (m.attribution === 'user' || m.attribution === 'steer') && (m.content || []).some((c) => c.type === 'text' && re.test(c.text)));
}

export class ToolRuns {
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

  /** Whether this call waits for the user, given the approval mode, what was allowed this session and trusted commands. */
  _mustAsk(call, args) {
    const mode = this.config.data.approvals;
    // A file outside the project folder is asked about every time, read-only or not (except under Full access): text in the
    // project could otherwise point the agent at ~/.ssh or a .env elsewhere and send it on with web_fetch.
    if (mode !== 'auto' && this._outside(call, args)) return !this.allowAlways.has(`${call.name}:outside`);
    // A destructive command asks every time, in every mode: Full access, "allow for this session", a trusted command and a
    // run's approved scope never cover it.
    if (call.name === 'bash' && destructiveReason(args?.command)) return true;
    // web_fetch follows your network rules: a site on the allowed list runs, and with an allowed list in use any
    // other site asks (denied sites never get here, see _runTool). Full access does not skip this: it is a rule you wrote.
    if (call.name === 'web_fetch') {
      const v = siteVerdict(args?.url, this.config.data.network);
      if (v === 'ask') return !this.allowAlways.has('web_fetch:site');
      if (v === 'allow') return false;
    }
    if (!this._needsApproval(call.name)) return false;
    if (mode === 'auto' || this.allowAlways.has(call.name)) return false;
    if ((mode === 'edits' || mode === 'safe') && (call.name === 'edit' || call.name === 'write')) return false;
    if (mode === 'safe' && call.name === 'bash' && readOnlyCommand(args?.command)) return false;
    if (call.name === 'bash' && args?.shell !== 'powershell' && isTrustedCommand(args?.command, this.config.data.trusted)) return false;
    return true;
  }

  /**
   * The one path every tool call takes: PreToolUse hooks, then `gate` (approval; a result from it means not run), a
   * stop check before and after it, the call, then PostToolUse feedback for the model. Main agent and helpers alike.
   */
  async _hooked(name, input, signal, { gate, exec }) {
    const stopped = { text: 'Not run: the agent was stopped before this step.', isError: true };
    const pre = await this.hooks.run('PreToolUse', { tool: name, input }, signal);
    if (pre.blocked) return { text: `Blocked by a hook: ${pre.reason}`, isError: true };
    if (signal?.aborted) return stopped;
    const refused = gate ? await gate() : undefined;
    if (refused) return refused;
    if (signal?.aborted) return stopped;
    let r = await exec();
    if (!signal?.aborted) {
      // PostToolUse hooks can add feedback for the model (a failed check, a lint warning).
      const post = await this.hooks.run('PostToolUse', { tool: name, input, extra: { result: { text: clip(String(r.text ?? ''), 8000), isError: !!r.isError } } }, signal);
      if (post.blocked) r = { ...r, text: `${r.text}
[Hook feedback] ${post.reason}` };
    }
    return r;
  }

  /** True when a file tool points outside the project folder. */
  _outside(call, args) {
    return PATH_TOOLS.has(call.name) && args?.path != null && String(args.path).trim() !== '' && !this.tools.inProject(args.path);
  }

  _askTitle(call) {
    const a = call.arguments || {};
    if (this._outside(call, a)) return `${{ read: 'Read a file outside the project?', grep: 'Search outside the project?', glob: 'List files outside the project?', write: 'Write a file outside the project?', edit: 'Edit a file outside the project?' }[call.name]}  ${clip(String(a.path), 200)}`;
    if (this.mcp.has(call.name)) return `Allow MCP tool ${this.mcp.describe(call.name)}?  ${clip(JSON.stringify(a), 200)}`;
    if (call.name === 'web_fetch') return `Read this page? The site is not on your allowed list.  ${clip(String(a.url ?? ''), 200)}`;
    const detail = call.name === 'bash' ? `${a.shell === 'powershell' ? '[PowerShell] ' : ''}${a.command ?? ''}` : a.path;
    const risk = call.name === 'bash' ? destructiveReason(a.command) : '';
    if (risk) return `Run this command? It ${risk}.  ${clip(String(detail ?? ''), 200)}`;
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

  /**
   * Run tool calls: consecutive read-only calls run side by side, everything else one at a time. Results are added
   * to the conversation in the order of the calls, whatever order they finish in: some models match results to
   * calls by position, not by id.
   */
  async _runTools(calls, conn) {
    const results = new Array(calls.length);
    let i = 0;
    while (i < calls.length && !this.abortCtl.signal.aborted) {
      if (this._isReadOnly(calls[i].name)) {
        let j = i;
        while (j < calls.length && this._isReadOnly(calls[j].name)) j++;
        const done = await Promise.all(calls.slice(i, j).map((c) => this._runTool(c, conn)));
        done.forEach((m, k) => (results[i + k] = this._add(m)));
        i = j;
      } else {
        results[i] = this._add(await this._runTool(calls[i], conn));
        i++;
      }
    }
    // Every tool call must have a result, even when the run was stopped, or the next request would be invalid.
    for (let k = 0; k < calls.length; k++) if (!results[k]) results[k] = this._record(calls[k], { text: 'Not run: the agent was stopped before this step.', isError: true }, false);
    return results;
  }

  /** Record a tool result and add it to the conversation at once. */
  _record(call, result, announce = true, startedAt) {
    return this._add(this._toolMessage(call, result, announce, startedAt));
  }

  /**
   * The toolResult message for a finished call, not yet added to the conversation: keeps its undo checkpoint and
   * tells the UI the call ended (`announce`).
   */
  _toolMessage(call, result, announce = true, startedAt) {
    const content = [{ type: 'text', text: result.text }, ...(result.images || [])];
    const details = { ...(result.details || {}) };
    const undo = details.undo;
    delete details.undo;
    if (undo && !undo.skipped) {
      this.checkpoints.set(call.id, undo);
      this._persistRaw({ type: 'checkpoint', toolCallId: call.id, undo });
      details.undoable = true;
      this.run?.edits.push(call.id); // what the run-end check and review look at
    }
    if (startedAt && details.wallTimeMs == null) details.wallTimeMs = Date.now() - startedAt;
    if (call.name === 'todo' && details.phases) this.todoPhases = details.phases;
    if (announce) this._emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content, details }, isError: !!result.isError });
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content, details, isError: !!result.isError, timestamp: Date.now() };
  }

  /** Ask mode allows read-only tools, and bash only for commands that only read. Returns the refusal, or undefined. */
  _askBlocked(call) {
    if (this.chatMode !== 'ask' || this.planMode || this._isReadOnly(call.name)) return undefined;
    if (call.name === 'bash' && readOnlyCommand(call.arguments?.command)) return undefined;
    return { text: call.name === 'bash'
      ? 'Ask mode is on: only read-only commands run (ls, cat, grep, find, git status/diff/log and pipes of them). The user can switch to Agent mode to make changes.'
      : 'Ask mode is on: this tool is not available. The user can switch to Agent mode to make changes.', isError: true };
  }

  /** Ask the user about a call that needs approval. Returns the denial result, or undefined when it may run. */
  async _approve(call, args, title = this._askTitle(call)) {
    const risky = call.name === 'bash' && !!destructiveReason(args.command); // asked every time, so no lasting choice is offered
    const canTrust = !risky && call.name === 'bash' && args.shell !== 'powershell' && trustableCommand(args.command);
    const ans = await this._askUser(title, risky ? ['Allow once', 'Deny'] : canTrust ? ['Allow once', 'Allow for this session', 'Always allow this command', 'Deny'] : ['Allow once', 'Allow for this session', 'Deny']);
    if (!ans || ans === 'Deny') return { text: 'The user denied this action. Do not retry it; ask what they want instead.', isError: true };
    if (ans === 'Allow for this session') this.allowAlways.add(this._outside(call, args) ? `${call.name}:outside` : call.name === 'web_fetch' ? 'web_fetch:site' : call.name);
    else if (ans === 'Always allow this command' && canTrust) this.config.addTrusted(args.command);
    return undefined;
  }

  /** The `artifact` tool: a new revision of one of the run's documents. */
  async _saveArtifact(args) {
    if (!this.runInfo) return { text: 'This conversation is not a run, so there is nowhere to save an artifact.', isError: true };
    try {
      const r = await this.runInfo.writeArtifact({ kind: String(args.kind || ''), title: String(args.title || ''), content: String(args.content ?? '') });
      return { text: r.unchanged ? `Unchanged: this is the same as revision ${r.rev} of the ${r.kind}.` : `Saved revision ${r.rev} of the ${r.kind}. The user can read and comment on it.`, details: { artifact: r.kind, rev: r.rev } };
    } catch (e) {
      return { text: e?.message || String(e), isError: true };
    }
  }

  /**
   * Track identical failing calls in this run (`run.repeat`: { key, fail, count }). Returns the result, with a note
   * once the same failure repeats REPEAT_NOTE times in a row. A different call, or any success, starts over.
   */
  _noteRepeat(key, result) {
    const run = this.run;
    if (!run) return result;
    if (result.details?.repeated) {
      run.repeatBlocked = (run.repeatBlocked || 0) + 1;
      return result;
    }
    const fail = result.isError ? failureOf(result.text) : null;
    const r = run.repeat;
    if (fail !== null && r?.key === key && r.fail === fail) r.count++;
    else run.repeat = fail === null ? null : { key, fail, count: 1 };
    const n = run.repeat?.count || 0;
    if (n < REPEAT_NOTE) return result;
    return { ...result, text: `${result.text}\n[This exact call has now failed ${n} times in a row with the same error. Sending it again unchanged will fail again: find the cause (read the file, check the path or the command), change the arguments or the approach, or stop and tell the user what is blocking you.]` };
  }

  /** The result for a call that already failed REPEAT_BLOCK - 1 times in a row the same way, or undefined. */
  _repeatBlocked(key) {
    const r = this.run?.repeat;
    if (!r || r.key !== key || r.count < REPEAT_BLOCK - 1) return undefined;
    return { text: `Not run: this exact call already failed ${r.count} times in a row with the same error, so it was not sent again. Do something different, or stop and tell the user what is blocking you.`, isError: true, details: { repeated: true } };
  }

  async _runTool(call, conn) {
    const args = call.arguments || {};
    const key = callKey(call);
    let t0 = Date.now();
    const intent = call.name === 'bash' ? clip(String(args.description || args.command || ''), 80) : call.name === 'web_fetch' ? clip(String(args.url ?? ''), 80) : this.mcp.has(call.name) ? this.mcp.describe(call.name) : undefined;
    this._emit({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args, intent });
    const askRefusal = this._askBlocked(call);
    let result;
    if (call.truncated || call.invalidArguments) {
      result = call.truncated
        ? { text: 'Not run: this tool call was cut off because the reply reached the output token limit. Make smaller calls: for a large file, write the first part, then add the rest with edit.', isError: true }
        : { text: invalidArgsText(this._toolDefs().find((d) => d.name === call.name)), isError: true };
    } else if (this.planMode && !this._isReadOnly(call.name)) result = { text: 'Plan mode is on, so this tool is not available. Only read and plan; the user can turn plan mode off with /plan.', isError: true };
    else if (askRefusal) result = askRefusal;
    else if ((!this.defs.some((d) => d.name === call.name) && !this.mcp.has(call.name) && !(call.name === 'artifact' && this.runInfo)) || (call.name === 'web_search' && !this._searchOn())) result = { text: `Unknown tool "${call.name}". Available tools: ${this._toolDefs().map((d) => d.name).join(', ')}.`, isError: true };
    else result = this._repeatBlocked(key);
    if (!result) {
      const signal = this.abortCtl.signal;
      const onUpdate = (text) => this._emit({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args, partialResult: { content: [{ type: 'text', text }], details: {} } });
      result = await this._hooked(call.name, args, signal, {
        // Asked after the PreToolUse hooks, so a hook can stop a call before you see it.
        gate: async () => {
          if (call.name === 'web_fetch' && siteVerdict(args.url, this.config.data.network) === 'deny') return { text: 'Blocked by the user\'s network rules (Settings → Preferences → Network access rules). Do not retry this site.', isError: true, details: { url: String(args.url ?? ''), blocked: true } };
          if (call.name === 'bash' && this.config.data.commandGuard !== false) {
            const why = catastrophicReason(args?.command);
            if (why) return { text: `Blocked by Command Guard: this command ${why}. It is never run, with or without approval. Find another way, or ask the user to do it themselves.`, isError: true };
          }
          if (!this._mustAsk(call, args)) return undefined;
          const denied = await this._approve(call, args);
          t0 = Date.now(); // the run time counts from your answer, not the time the call waited for you
          return denied;
        },
        exec: async () => {
          let r;
          if (call.name === 'task') r = await this._runTask(call, conn);
          else if (call.name === 'artifact') r = await this._saveArtifact(args);
          else if (this.mcp.has(call.name)) r = await this.mcp.call(call.name, args, signal);
          else r = await this.tools.run(call.name, args, { onUpdate, allowHost: (h) => this._allowHost(h), vision: this._vision(), search: () => this.config.searchConfig?.(), denied: (u) => siteVerdict(u, this.config.data.network) === 'deny' });
          return r.images?.length && !this._vision() ? { ...r, images: undefined } : r;
        },
      });
    }
    // A run that was stopped is not a failure of the call.
    if (!this.abortCtl.signal.aborted) result = this._noteRepeat(key, result);
    return this._toolMessage(call, result, true, t0); // added to the conversation by _runTools, in call order
  }
}
