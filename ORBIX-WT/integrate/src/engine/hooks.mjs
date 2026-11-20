// Hooks: your own commands that run at fixed points of the agent's work.
//   SessionStart      once per open session, when its first message is accepted, before the first model call
//                     (can add context; cannot block). `source` is "new" or "resume" (a saved conversation)
//   UserPromptSubmit  when you send a message (can block it, or add context)
//   PreInvocation     before each model call of the agent loop (can stop the run, or add context)
//   PostInvocation    after each model reply is complete, before its tool calls run (can stop the run: the calls
//                     are not run; or add context, which the model sees at its next call)
//   PreToolUse        before a tool runs (can block it)
//   PostToolUse       after a tool ran (can add feedback for the model)
//   Stop              when the agent is about to finish (can make it continue, once per run)
// One "invocation" is one request to the model inside the agent loop, including the single retry of a reply that broke
// off or came back empty; title, compaction and review requests are not invocations.
// Files: DATA_DIR/hooks.json (yours) and <project>/.orbix/hooks.json (needs a one-time OK, like MCP project servers):
//   { "hooks": { "PreToolUse": [ { "matcher": "bash|edit", "command": "node check.js", "timeout": 10 } ] } }
// An entry can also hold its commands in a list: { "matcher": "bash", "hooks": [ { "type": "command", "command": … } ] }.
// A hook gets JSON on stdin { event, tool, input, cwd, sessionId } (+ prompt / result / invocation fields).
// Decisions: exit code 2 blocks, and its stderr goes to the model. Or print one JSON object on stdout (parseHookOutput):
//   {"decision": "block" | "deny" | "allow" | "continue", "reason": "...", "additionalContext": "..."}
// "block"/"deny" blocks; "allow" is an explicit no-objection (approvals still apply); "continue" on Stop is the same as
// "block" (keep working). {"terminationBehavior": "terminate"} counts as block, and {"injectSteps": [{"systemMessage":
// …}]} as context. Context is used by SessionStart, UserPromptSubmit, Pre/PostInvocation and PostToolUse. Any other
// non-zero exit is only a warning. Hooks run in the session's shell (cmd.exe, or bash in WSL), 10 s at most, output
// capped. Nothing here logs the command's environment, input or output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../store.mjs';
import { readJson, writeJson } from '../util.mjs';
import { killTree } from '../backend.mjs';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
const HOOK_TIMEOUT_MS = 10000;
const MAX_OUTPUT = 16 * 1024;
const MAX_INPUT = 64 * 1024;
const MAX_HOOKS = 50;
const trustPath = () => path.join(DATA_DIR, 'hooks-trust.json');

export const userHooksPath = () => path.join(DATA_DIR, 'hooks.json');
export const projectHooksPath = (hostRoot) => path.join(hostRoot, '.orbix', 'hooks.json');

/** Read one hooks file: { file, exists, hooks: { Event: [{ matcher, command, timeout }] }, errors: [] }. Never throws. */
export function readHooksFile(file) {
  const out = { file, exists: false, hooks: {}, errors: [], count: 0 };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
    out.exists = true;
  } catch {
    return out;
  }
  let json;
  try {
    json = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    out.errors.push(`Not valid JSON: ${e.message}`);
    return out;
  }
  const hooks = json && typeof json === 'object' ? json.hooks : null;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    out.errors.push('Expected {"hooks": {"PreToolUse": [...]}}');
    return out;
  }
  for (const [event, list] of Object.entries(hooks)) {
    if (!HOOK_EVENTS.includes(event)) {
      out.errors.push(`Unknown event "${event}". Use ${HOOK_EVENTS.join(', ')}.`);
      continue;
    }
    if (!Array.isArray(list)) {
      out.errors.push(`${event} must be a list`);
      continue;
    }
    // { matcher, hooks: [{ type: "command", command, timeout }] } entries are the same as one entry per command.
    const flat = list.flatMap((h) => (h && Array.isArray(h.hooks) ? h.hooks.map((x) => (x && typeof x === 'object' ? { matcher: h.matcher, ...x } : x)) : [h]));
    for (const h of flat) {
      if (out.count >= MAX_HOOKS) {
        out.errors.push(`Only the first ${MAX_HOOKS} hooks are used`);
        break;
      }
      if (h && h.type != null && h.type !== 'command') {
        out.errors.push(`A ${event} hook has type "${h.type}"; only "command" is supported`);
        continue;
      }
      if (!h || typeof h.command !== 'string' || !h.command.trim()) {
        out.errors.push(`A ${event} hook has no "command"`);
        continue;
      }
      let matcher = typeof h.matcher === 'string' ? h.matcher.trim() : '';
      if (matcher === '*') matcher = '';
      if (matcher) {
        try {
          new RegExp(`^(?:${matcher})$`, 'i');
        } catch {
          out.errors.push(`${event}: the matcher "${matcher}" is not a valid pattern`);
          continue;
        }
      }
      const t = Number(h.timeout);
      (out.hooks[event] ||= []).push({ matcher, command: h.command.trim(), timeout: Number.isFinite(t) && t > 0 ? Math.min(t, HOOK_TIMEOUT_MS / 1000) : HOOK_TIMEOUT_MS / 1000 });
      out.count++;
    }
  }
  return out;
}

/** Flat list for display: [{ event, matcher, command }]. */
export const listHooks = (r) => Object.entries(r.hooks).flatMap(([event, l]) => l.map((h) => ({ event, matcher: h.matcher, command: h.command, timeout: h.timeout })));

const trustKey = (scopeRoot, hooks) => crypto.createHash('sha256').update(JSON.stringify([scopeRoot, hooks])).digest('hex').slice(0, 32);
export const hooksTrusted = (scopeRoot, hooks) => (readJson(trustPath(), {})?.trusted || []).includes(trustKey(scopeRoot, hooks));
function addTrust(scopeRoot, hooks) {
  const j = readJson(trustPath(), {}) || {};
  j.trusted = [...new Set([...(j.trusted || []), trustKey(scopeRoot, hooks)])].slice(-500);
  writeJson(trustPath(), j);
}

/** The words of the trust question: every command, nothing hidden (long ones keep start and end). */
export function describeHooks(hooks) {
  const text = Object.entries(hooks)
    .flatMap(([event, l]) => l.map((h) => `${event}${h.matcher ? `[${h.matcher}]` : ''}: ${h.command.replace(/\s+/g, ' ')}`))
    .join(' | ');
  return text.length > 900 ? `${text.slice(0, 600)} … [${text.length - 900} characters not shown] … ${text.slice(-300)}` : text;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [cut]` : s);

/**
 * A hook's stdout as a decision: { decision: 'block' | 'allow' | 'continue' | null, reason, context }, or null when
 * it is not one JSON object (plain output is ignored, as before).
 */
export function parseHookOutput(stdout) {
  const out = String(stdout ?? '').trim();
  if (!out.startsWith('{')) return null;
  let j;
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const d = typeof j.decision === 'string' ? j.decision.trim().toLowerCase() : '';
  const tb = typeof j.terminationBehavior === 'string' ? j.terminationBehavior.trim().toLowerCase() : '';
  let decision = null;
  if (d === 'block' || d === 'deny' || tb === 'terminate') decision = 'block';
  else if (d === 'continue' || tb === 'force_continue') decision = 'continue';
  else if (d === 'allow' || d === 'approve' || d === 'auto_approve') decision = 'allow';
  const context = [];
  for (const v of [j.additionalContext, j.hookSpecificOutput?.additionalContext]) if (typeof v === 'string' && v.trim()) context.push(v.trim());
  if (Array.isArray(j.injectSteps)) for (const st of j.injectSteps) for (const k of ['systemMessage', 'userMessage', 'ephemeralMessage']) if (typeof st?.[k] === 'string' && st[k].trim()) context.push(st[k].trim());
  return { decision, reason: typeof j.reason === 'string' ? j.reason.trim() : '', context: context.join('\n') };
}

// Events whose hooks can add text for the model; and the one where "continue" means "do not stop yet".
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreInvocation', 'PostInvocation', 'PostToolUse']);
const CAN_BLOCK = new Set(['UserPromptSubmit', 'PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);

/** Run one command with `payload` on stdin. Resolves { code, stdout, stderr, timedOut } and never rejects. */
function runCommand({ backend, command, cwd, payload, timeoutMs, signal, shell }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = backend.spawnShell(command, { cwd, env: { ORBIX_HOOK: '1' }, ...(shell ? { shell } : {}) });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: `could not start: ${e.message}`, timedOut: false });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const kill = () => {
      killTree(child);
      setTimeout(() => finish(-1), 1500).unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(0, MAX_OUTPUT)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(0, MAX_OUTPUT)));
    child.on('error', (e) => {
      stderr += e.message;
      finish(-1);
    });
    child.on('close', (c) => finish(c ?? -1));
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

/**
 * Hooks of one session. `ask(title, options)` is the session's question dialog; `notice(level, message)` shows a note.
 * Project hooks run only after the user said yes (once, or remembered for that exact file content).
 */
export class HookRunner {
  constructor({ backend, workspace, hostRoot, getSessionId, ask, notice }) {
    this.backend = backend;
    this.workspace = workspace;
    this.hostRoot = hostRoot;
    this.getSessionId = getSessionId;
    this.ask = ask;
    this.notice = notice;
    this.decided = null; // JSON of the project hooks this session decided about
    this.allowed = false;
    this.warned = new Set();
  }

  /** The hooks to run now: yours plus the project's when allowed. Asks once if the project has some. */
  async active() {
    const user = readHooksFile(userHooksPath());
    const proj = readHooksFile(projectHooksPath(this.hostRoot));
    const sets = [user.hooks];
    for (const r of [user, proj]) for (const e of r.errors) this._warnOnce(`${r.file}:${e}`, `Hooks (${r === user ? 'your hooks.json' : '.orbix/hooks.json'}): ${e}`);
    if (proj.count) {
      const sig = JSON.stringify(proj.hooks);
      const scope = this.backend.keyPath(this.workspace);
      if (this.decided !== sig) {
        this.decided = sig;
        this.allowed = hooksTrusted(scope, proj.hooks);
        if (!this.allowed) {
          // The question's title can be cut short on screen, so the full list is also written into the conversation.
          this.notice('info', `This project's .orbix/hooks.json would run: ${describeHooks(proj.hooks)}`);
          const ans = await this.ask(`This project's .orbix/hooks.json wants to run commands on your PC: ${describeHooks(proj.hooks)}`, ['Allow and remember', 'Allow once', 'Do not run']);
          if (ans === 'Allow and remember') {
            addTrust(scope, proj.hooks);
            this.allowed = true;
          } else this.allowed = ans === 'Allow once';
        }
      }
      if (this.allowed) sets.push(proj.hooks);
    }
    return sets;
  }

  _warnOnce(key, msg) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.notice('warn', msg);
  }

  /**
   * Run the hooks of `event`. `info`: { tool, input, extra }. Returns { blocked, reason, allowed, context }: `reason` is
   * the text for the model when a hook blocked (exit 2 with stderr, or a JSON block decision), `context` the text the
   * hooks added (events in CONTEXT_EVENTS), `allowed` whether a hook said "allow" and none blocked. SessionStart cannot
   * block; a block there is reported as a note and ignored.
   */
  async run(event, info = {}, signal) {
    const sets = await this.active();
    const list = sets.flatMap((s) => s[event] || []).filter((h) => !h.matcher || (info.tool && new RegExp(`^(?:${h.matcher})$`, 'i').test(info.tool)));
    if (!list.length) return { blocked: false, allowed: false, context: '' };
    let payload = JSON.stringify({ event, tool: info.tool, input: info.input, cwd: this.workspace, sessionId: this.getSessionId() || null, ...(info.extra || {}) });
    if (payload.length > MAX_INPUT) payload = JSON.stringify({ event, tool: info.tool, input: '[too large]', cwd: this.workspace, sessionId: this.getSessionId() || null, truncated: true });
    const context = [];
    let allowed = false;
    const label = `${event}${info.tool ? ` ${info.tool}` : ''}`;
    for (const h of list) {
      if (signal?.aborted) break;
      const r = await runCommand({ backend: this.backend, command: h.command, cwd: this.workspace, payload, timeoutMs: h.timeout * 1000, signal, shell: undefined });
      if (r.timedOut) {
        this.notice('warn', `A ${label} hook took longer than ${h.timeout} s and was stopped.`);
        continue;
      }
      let reason = '';
      let block = false;
      if (r.code === 2) {
        block = true;
        reason = r.stderr.trim() || r.stdout.trim() || 'Blocked by a hook.';
      } else {
        const j = parseHookOutput(r.stdout);
        if (j?.decision === 'block' || (j?.decision === 'continue' && event === 'Stop')) {
          block = true;
          reason = j.reason || (event === 'Stop' ? 'A hook asked to keep going.' : 'Blocked by a hook.');
        } else if (j?.decision === 'allow') allowed = true;
        if (j?.context && CONTEXT_EVENTS.has(event)) context.push(clip(j.context, 4000));
        if (!block && r.code !== 0) this.notice('warn', `A ${label} hook failed (exit code ${r.code})${r.stderr.trim() ? `: ${clip(r.stderr.trim().split('\n')[0], 200)}` : ''}. It was ignored.`);
      }
      if (block && !CAN_BLOCK.has(event)) {
        this.notice('warn', `A ${label} hook cannot block, so its answer was ignored: ${clip(reason, 200)}`);
        continue;
      }
      if (block) return { blocked: true, reason: clip(reason, 2000), allowed: false, context: context.join('\n') };
    }
    return { blocked: false, allowed, context: context.join('\n') };
  }
}
