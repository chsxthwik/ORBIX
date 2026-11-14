// The checks at the end of a run that changed files: the project's check command (tests, build or lint), run until it
// passes or VERIFY_MAX times, and a review of the diff by the fast model. Part of AgentProc (see proc.mjs and
// mixin.mjs): these methods use the agent's run, messages, tools, backend and connection.
import path from 'node:path';
import { clip, uid, textOf } from '../util.mjs';
import { collectTurn } from './assemble.mjs';
import { stripSgr } from './files.mjs';
import { zeroUsage } from './proc-usage.mjs';
import { detectCheck, sameCommand, outputTail, verifyFailedText, REVIEW_SYSTEM, reviewPrompt, parseReview, reviewIssuesText } from './verify.mjs';

// Run-end checks stay bounded: the check runs at most VERIFY_MAX times per run, the review once, and not at all for
// a diff under REVIEW_MIN_LINES changed lines.
const VERIFY_MAX = 3;
const VERIFY_TIMEOUT_S = 300;
const REVIEW_MIN_LINES = 5;
const REVIEW_MAX_CHARS = 40000;
const REVIEW_TIMEOUT_MS = 120000;

export class RunChecks {
  _runEdits() {
    return (this.run?.edits || []).filter((id) => this.checkpoints.has(id) && !this.undone.has(id));
  }

  /**
   * At the end of a run that changed files: run the project's check (again after each round of fixes, at most
   * VERIFY_MAX times) and review the diff once. Returns true when the model gets another round to fix what was found.
   */
  async _finishChecks(conn) {
    const c = this.run.checks;
    const edits = this._runEdits();
    if (!edits.length || this.planMode || this.abortCtl.signal.aborted) return false;
    if (c.review?.status === 'issues') c.review.fixed = edits.length > c.reviewAt;
    if (edits.length > (c.checkedAt || 0) && !c.verifyOff && (c.verify?.runs || 0) < VERIFY_MAX) {
      c.checkedAt = edits.length;
      const v = await this._verify();
      if (this.abortCtl.signal.aborted) return false;
      if (v === 'failed') return true;
    }
    // A failing check already sent the model back once; a review on top of it would cost more and find the same thing.
    if (!c.reviewed && this.config.data.review !== false && c.verify?.status !== 'failed') {
      c.reviewed = true;
      return this._review(conn, edits);
    }
    return false;
  }

  /** The project's check command: the one chosen for this project in Settings, else found from its files, or null. */
  _checkCommand() {
    const own = this.config.checkCommand?.(this.backend.keyPath(this.workspace)) || '';
    if (own === 'off') return null;
    if (own) return { command: own, source: 'project setting' };
    return detectCheck(this.backend.hostPath(this.workspace), { wsl: !!this.backend.isWsl });
  }

  /** The result of `command` when the agent itself ran it after its last edit in this run (bash details), else null. */
  _ranAfterEdits(command) {
    const msgs = this.messages.slice(this.run.from);
    const edits = new Set(this.run.edits);
    const args = new Map();
    for (const m of msgs) if (m.role === 'assistant') for (const b of m.content || []) if (b.type === 'toolCall') args.set(b.id, b.arguments || {});
    let found = null;
    for (const m of msgs) {
      if (m.role !== 'toolResult') continue;
      if (edits.has(m.toolCallId)) found = null;
      else if (m.toolName === 'bash' && sameCommand(args.get(m.toolCallId)?.command, command) && !m.details?.aborted) found = m.details || {};
    }
    return found;
  }

  _status(key, text) {
    this._emit({ type: 'extension_ui_request', id: `status-${key}-${Date.now()}`, method: 'setStatus', statusKey: key, statusText: text });
  }

  /** Run the project's check after edits. Returns 'passed', 'failed', or null when it did not run. */
  async _verify() {
    const c = this.run.checks;
    const mode = this.config.data.verify || 'ask';
    const found = mode === 'off' ? null : this._checkCommand();
    if (!found) {
      c.verifyOff = true;
      return null;
    }
    const { command } = found;
    const runs = c.verify?.runs || 0;
    const note = (status, text, details, forModel = false) => {
      c.verify = { status, command, runs: runs + 1, ...(details.exitCode != null ? { exitCode: details.exitCode } : {}), ...(details.by ? { by: details.by } : {}) };
      this._add({ role: 'custom', customType: 'verify', forModel, display: true, content: [{ type: 'text', text }], details: { status, command, ...details }, timestamp: Date.now() });
      return status;
    };
    // The agent already ran this exact check after its last edit: running it again would only repeat that result.
    const own = this._ranAfterEdits(command);
    if (own) {
      c.verifyOff = true; // it saw the output itself, so a failure is not sent back to it again
      return own.exitCode === 0 ? note('passed', `Checks passed: ${command}`, { exitCode: 0, by: 'agent' }) : (note('failed', `Checks failed: ${command} (exit code ${own.exitCode})`, { exitCode: own.exitCode, by: 'agent' }), null);
    }
    if (mode === 'ask' && !c.verifyApproved) {
      const ans = await this._askUser(`Check the changes with ${command}?`, ['Run the check', 'Skip']);
      if (ans !== 'Run the check') {
        c.verifyOff = true;
        c.verify = { status: 'skipped', command, runs };
        return null;
      }
      c.verifyApproved = true; // one answer covers the re-checks after fixes in this run
    }
    const args = { command, timeout: VERIFY_TIMEOUT_S };
    const call = { id: uid('check'), name: 'bash', arguments: args };
    const signal = this.abortCtl.signal;
    // The same path as a bash call from the model: hooks, approval (unless you just said yes above), shell backend.
    const pre = await this.hooks.run('PreToolUse', { tool: 'bash', input: args }, signal);
    let denied = pre.blocked ? `A hook blocked the check: ${pre.reason}` : '';
    if (!denied && !c.verifyApproved && this._mustAsk(call, args) && (await this._approve(call, args, `Run the project's check?  ${command}`))) denied = 'You denied the check command.';
    if (denied || signal.aborted) {
      c.verifyOff = true;
      c.verify = { status: 'skipped', command, runs };
      if (denied) this._emit({ type: 'notice', level: 'info', message: denied });
      return null;
    }
    this._status('verify', `Checking the changes: ${command}`);
    let r;
    try {
      r = await this.tools.run('bash', args, {});
    } finally {
      this._status('verify', '');
    }
    if (signal.aborted || r.details?.aborted) return null;
    const post = await this.hooks.run('PostToolUse', { tool: 'bash', input: args, extra: { result: { text: clip(String(r.text ?? ''), 8000), isError: !!r.isError } } }, signal);
    const output = stripSgr(String(r.text ?? '')) + (post.blocked ? `\n[Hook feedback] ${post.reason}` : '');
    const d = r.details || {};
    const details = { exitCode: d.exitCode ?? (r.isError ? 1 : 0), durationMs: d.durationMs, ...(d.timedOut ? { timedOut: true } : {}), output: outputTail(output, 4000) };
    if (!r.isError && details.exitCode === 0) return note('passed', `Checks passed: ${command}`, details);
    return note('failed', verifyFailedText({ command, exitCode: details.exitCode, timedOut: !!d.timedOut, output }), details, true);
  }

  /**
   * One review of the run's diff by the fast model (or the session's model when none is chosen), skipped for tiny
   * edits. Returns true when it found issues: they go to the model as a note and it gets one more round.
   */
  async _review(conn, edits) {
    const c = this.run.checks;
    // One diff per file: from its state before the first edit in this run to now.
    const first = new Map();
    for (const id of edits) {
      const u = this.checkpoints.get(id);
      if (u && !first.has(u.path)) first.set(u.path, u);
    }
    const diffs = (await Promise.all([...first.values()].map((u) => this.tools.diffSince(u).catch(() => null)))).filter(Boolean);
    const lines = diffs.reduce((n, d) => n + d.added + d.removed, 0);
    if (lines < REVIEW_MIN_LINES || this.abortCtl.signal.aborted) return false;
    let room = REVIEW_MAX_CHARS;
    const parts = [];
    for (const d of diffs) {
      if (room <= 0) break;
      const diff = d.diff.length > room ? `${d.diff.slice(0, room)}\n[… rest of this diff omitted …]` : d.diff;
      parts.push({ path: d.path, diff });
      room -= diff.length;
    }
    // What the user asked: their messages in this run (a regenerated run has none, so the last one before it).
    const own = this.messages.slice(this.run.from).filter((m) => m.role === 'user');
    const asked = own.length ? own : [...this.messages.slice(0, this.run.from)].reverse().filter((m) => m.role === 'user').slice(0, 1);
    const request = clip(asked.map((m) => textOf(m.content)).join('\n\n'), 4000) || '(not available)';
    const rconn = (await this._roleConnSafe('fast')) || conn;
    this._status('review', 'Reviewing the changes');
    let msg;
    try {
      msg = await collectTurn(rconn.stream({ system: REVIEW_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: reviewPrompt(request, parts) }], timestamp: Date.now() }], tools: [], signal: AbortSignal.any([this.abortCtl.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]), maxTokens: 1500, thinking: undefined }));
    } catch (e) {
      if (!this.abortCtl.signal.aborted) this._emit({ type: 'notice', level: 'warn', message: `The review of the changes did not run: ${e?.message || e}` });
      return false;
    } finally {
      this._status('review', '');
    }
    if (this.abortCtl.signal.aborted) return false;
    const usage = { ...zeroUsage(), ...msg.usage };
    const cost = this._costOf(usage, rconn.info);
    this._addUsage(usage, cost);
    const issues = parseReview(textOf(msg.content));
    const model = `${rconn.provider}/${rconn.model}`;
    const base = { role: 'custom', customType: 'review', display: true, usage, ...(cost !== undefined ? { cost } : {}), timestamp: Date.now() };
    if (!issues.length) {
      c.review = { status: 'clean' };
      this._add({ ...base, forModel: false, content: [{ type: 'text', text: 'Review found no issues.' }], details: { status: 'clean', files: diffs.length, lines, model } });
      return false;
    }
    c.review = { status: 'issues', count: issues.length, fixed: false };
    c.reviewAt = edits.length;
    this._add({ ...base, forModel: true, content: [{ type: 'text', text: reviewIssuesText(issues) }], details: { status: 'issues', issues, files: diffs.length, lines, model } });
    return true;
  }
}
