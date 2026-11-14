// Running the model's tool calls: approvals (ask, allow always, trusted commands), hooks, paths outside the project,
// local network addresses, and recording each result. Part of AgentProc (see proc.mjs and mixin.mjs).
import path from 'node:path';
import { clip } from '../util.mjs';
import { invalidArgsText } from './tools.mjs';
import { isTrustedCommand, trustableCommand } from './store.mjs';

// File tools whose path is checked against the project folder before they run.
const PATH_TOOLS = new Set(['read', 'grep', 'glob', 'write', 'edit']);

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
    // A file outside the project folder is asked about every time, read-only or not (except under Allow everything):
    // text in the project could otherwise point the agent at ~/.ssh or a .env elsewhere and send it on with web_fetch.
    if (mode !== 'auto' && this._outside(call, args)) return !this.allowAlways.has(`${call.name}:outside`);
    if (!this._needsApproval(call.name)) return false;
    if (mode === 'auto' || this.allowAlways.has(call.name)) return false;
    if (mode === 'edits' && (call.name === 'edit' || call.name === 'write')) return false;
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
      this.run?.edits.push(call.id); // what the run-end check and review look at
    }
    if (startedAt && details.wallTimeMs == null) details.wallTimeMs = Date.now() - startedAt;
    if (call.name === 'todo' && details.phases) this.todoPhases = details.phases;
    if (announce) this._emit({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, result: { content, details }, isError: !!result.isError });
    const tr = { role: 'toolResult', toolCallId: call.id, toolName: call.name, content, details, isError: !!result.isError, timestamp: Date.now() };
    return this._add(tr);
  }

  /** Ask the user about a call that needs approval. Returns the denial result, or undefined when it may run. */
  async _approve(call, args, title = this._askTitle(call)) {
    const canTrust = call.name === 'bash' && args.shell !== 'powershell' && trustableCommand(args.command);
    const ans = await this._askUser(title, canTrust ? ['Allow once', 'Allow for this session', 'Always allow this command', 'Deny'] : ['Allow once', 'Allow for this session', 'Deny']);
    if (!ans || ans === 'Deny') return { text: 'The user denied this action. Do not retry it; ask what they want instead.', isError: true };
    if (ans === 'Allow for this session') this.allowAlways.add(this._outside(call, args) ? `${call.name}:outside` : call.name);
    else if (ans === 'Always allow this command' && canTrust) this.config.addTrusted(args.command);
    return undefined;
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
      const signal = this.abortCtl.signal;
      const onUpdate = (text) => this._emit({ type: 'tool_execution_update', toolCallId: call.id, toolName: call.name, args, partialResult: { content: [{ type: 'text', text }], details: {} } });
      result = await this._hooked(call.name, args, signal, {
        // Asked after the PreToolUse hooks, so a hook can stop a call before you see it.
        gate: async () => {
          if (!this._mustAsk(call, args)) return undefined;
          const denied = await this._approve(call, args);
          t0 = Date.now(); // the run time counts from your answer, not the time the call waited for you
          return denied;
        },
        exec: async () => {
          let r;
          if (call.name === 'task') r = await this._runTask(call, conn);
          else if (this.mcp.has(call.name)) r = await this.mcp.call(call.name, args, signal);
          else r = await this.tools.run(call.name, args, { onUpdate, allowHost: (h) => this._allowHost(h), vision: this._vision(), search: () => this.config.searchConfig?.() });
          return r.images?.length && !this._vision() ? { ...r, images: undefined } : r;
        },
      });
    }
    return this._record(call, result, true, t0);
  }
}
