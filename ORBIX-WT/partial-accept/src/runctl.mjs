// The run controller: it takes a task from its description to reviewed changes, and records every step.
//
//   start      a run gets its own git worktree and an agent, which first only reads and writes a plan
//   plan       you read the plan, comment on it, send feedback (a new revision), then approve it with a scope
//   execute    the agent changes files in the worktree only, runs the checks and writes a walkthrough
//   review     you read the diff, the test log and the walkthrough, send feedback, then apply or discard
//   recover    a run that was working when ORBIX stopped is `interrupted`; resuming tells the agent what was in
//              flight, and an action with side effects is never repeated without you saying so
//
// The agent itself is the same AgentProc a conversation uses (src/engine/proc.mjs); this file drives it and listens.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { clip, log } from './util.mjs';
import * as gitapi from './gitapi.mjs';
import { RunStore, WORKING, FINAL, ARTIFACTS } from './runs.mjs';
import { appendEntry, closeSession } from './engine/store.mjs';
import { stripSgr } from './engine/files.mjs';

const bad = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** What one tool call was about, short enough for the log and never the file contents. */
function callDetail(name, args = {}) {
  if (name === 'bash') return clip(String(args.command ?? ''), 400);
  if (name === 'artifact') return String(args.kind || '');
  if (args.path != null) return clip(String(args.path), 300);
  if (args.url != null) return clip(String(args.url), 300);
  if (args.pattern != null) return clip(String(args.pattern), 200);
  if (name === 'task') return `${Array.isArray(args.tasks) ? args.tasks.length : 1} subtask(s)`;
  return '';
}

const resultText = (result) => clip(stripSgr((result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')).trim(), 300);

function testLog(d) {
  const head = d.status === 'passed' ? 'Passed' : d.status === 'failed' ? 'Failed' : d.status;
  const lines = [`# Test log`, '', `**${head}** · \`${d.command}\`${d.exitCode != null ? ` · exit code ${d.exitCode}` : ''}${d.durationMs != null ? ` · ${(d.durationMs / 1000).toFixed(1)} s` : ''}${d.by === 'agent' ? ' · run by the agent' : ''}${d.timedOut ? ' · timed out' : ''}`];
  if (d.output) lines.push('', '```', String(d.output).replace(/```/g, '`` `'), '```');
  return lines.join('\n');
}

/** `path:12` or `path:12-14` for a comment on lines of a changed file, else the path. */
export const commentWhere = (c) => (c.line ? `${c.target}:${c.line}${c.lineEnd && c.lineEnd !== c.line ? `-${c.lineEnd}` : ''}` : c.target);

/** The comments as the agent reads them. A comment on diff lines names `path:line` and quotes the lines. */
export function commentLines(comments) {
  return comments.map((c) => {
    if (c.line && !Object.hasOwn(ARTIFACTS, c.target)) {
      const old = c.side === 'old' ? ' (removed by your change; numbered as in the original file)' : '';
      const quoted = c.quote ? String(c.quote).split('\n').map((l) => `    > ${l}`) : [];
      return [`- On \`${commentWhere(c)}\`${old}: ${c.text}`, ...quoted].join('\n');
    }
    const about = Object.hasOwn(ARTIFACTS, c.target) ? `the ${ARTIFACTS[c.target].title.toLowerCase()}${c.rev ? ` (revision ${c.rev})` : ''}` : `\`${c.target}\``;
    return `- On ${about}${c.quote ? `, about "${c.quote.replace(/\s+/g, ' ')}"` : ''}: ${c.text}`;
  });
}

export class RunController {
  constructor(server, dir = path.join(DATA_DIR, 'runs')) {
    this.s = server;
    this.store = new RunStore(dir);
    this.live = new Map(); // run id -> AgentProc
    // Whatever was still working when ORBIX last stopped was cut off: say so instead of showing it as running.
    for (const run of this.store.reconcile()) log('run interrupted by the last shutdown', run.id, run.interrupted?.was);
  }

  view(run) {
    const proc = this.live.get(run.id);
    return {
      ...run,
      procId: proc?.id || '',
      streaming: !!proc?.streaming,
      asks: proc?.openUi ? [...proc.openUi.values()].map((a) => ({ id: a.id, title: a.title, options: a.options })) : [],
    };
  }

  list() {
    return this.store.list().map((r) => this.view(r));
  }

  notify(run) {
    this.s.broadcast({ g: 'run', run: this.view(run) });
  }

  // ---- Starting ----------------------------------------------------------------------------------------------------

  async start({ workspace, task, mode, model }) {
    const text = String(task || '').trim();
    if (!text) throw bad('Describe the task first.');
    if (!workspace) throw bad('Choose a project first.');
    const info = await gitapi.repoInfo(this.s.backend, workspace);
    if (!info) throw bad('A run works in its own git worktree, so the project must be a Git repository. Run "git init" and make a first commit, or use a conversation instead.');
    if (!info.head) throw bad('This repository has no commit yet. Make a first commit, then start the run.');
    const run = this.store.create({ project: workspace, task: text, mode });
    let proc;
    try {
      proc = await this.s.startProc({ workspace, model, branch: true });
    } catch (e) {
      this.store.remove(run.id);
      throw e;
    }
    this.store.update(run.id, { workspace: proc.workspace, worktree: proc.worktree, provider: proc.provider, model: proc.model });
    this.store.append(run.id, 'worktree.created', { branch: proc.worktree.branch, base: proc.worktree.base, baseBranch: proc.worktree.baseBranch, path: proc.worktree.path });
    if (run.mode === 'direct') {
      // No plan to approve: the start itself is the approval, for file edits in the worktree only.
      run.scope = { edits: true, commands: false, planRev: 0, at: Date.now() };
      this.store.save(run);
      this.store.append(run.id, 'scope.granted', { edits: true, commands: false, by: 'start' });
    }
    this.attach(run, proc);
    await proc.request({ type: 'prompt', message: text });
    this.notify(run);
    return this.view(run);
  }

  /** What the approved scope lets the agent do without asking again (only ever inside the worktree). */
  applyScope(run, proc) {
    proc.planMode = run.phase === 'plan';
    if (!run.scope) return;
    if (run.scope.edits) proc.allowAlways.add('write').add('edit');
    if (run.scope.commands) proc.allowAlways.add('bash');
  }

  attach(run, proc) {
    if (this.live.get(run.id) === proc) return;
    this.live.set(run.id, proc);
    proc.runId = run.id;
    proc.runInfo = {
      id: run.id,
      phase: () => run.phase,
      scope: () => run.scope,
      writeArtifact: (a) => {
        const r = this.store.writeArtifact(run.id, a);
        this.notify(run);
        return r;
      },
    };
    this.applyScope(run, proc);
    const session = () => {
      if (proc.session?.file && run.sessionFile !== proc.session.file) this.store.update(run.id, { sessionFile: proc.session.file, sessionId: proc.session.id });
    };
    proc.on('event', (ev) => {
      try {
        this.onEvent(run, proc, ev, session);
      } catch (e) {
        log('run event failed', run.id, ev?.type, e);
      }
    });
    proc.on('exit', () => {
      if (this.live.get(run.id) === proc) this.live.delete(run.id);
      // An agent that went away mid-work (the app is closing, or it crashed) leaves the run interrupted.
      if (this.store.has(run.id) && WORKING.has(run.status)) this.store.reconcile(new Set(this.live.keys()));
      if (this.store.has(run.id)) this.notify(run);
    });
  }

  onEvent(run, proc, ev, session) {
    switch (ev.type) {
      case 'agent_start':
        session();
        this.store.setStatus(run.id, run.phase === 'plan' ? 'planning' : 'executing', { error: '' });
        this.notify(run);
        break;
      case 'message_end': {
        session();
        const m = ev.message;
        if (m?.role === 'custom' && m.customType === 'verify' && m.details?.command) {
          const d = m.details;
          this.store.update(run.id, { checks: { status: d.status, command: d.command, exitCode: d.exitCode ?? null, durationMs: d.durationMs ?? null, at: Date.now() } });
          this.store.append(run.id, 'check.result', { status: d.status, command: clip(d.command, 300), exitCode: d.exitCode ?? null });
          this.store.writeArtifact(run.id, { kind: 'tests', content: testLog(d), author: 'orbix' });
          this.notify(run);
        }
        break;
      }
      case 'tool_execution_start':
        this.store.append(run.id, 'tool.call', { call: ev.toolCallId, name: ev.toolName, detail: callDetail(ev.toolName, ev.args), sideEffect: !proc._isReadOnly(ev.toolName) });
        break;
      case 'tool_execution_end': {
        const d = ev.result?.details || {};
        this.store.append(run.id, 'tool.result', { call: ev.toolCallId, name: ev.toolName, ok: !ev.isError, summary: resultText(ev.result), ...(d.undoable ? { changed: true } : {}), ...(d.exitCode != null ? { exitCode: d.exitCode } : {}), ...(d.artifact ? { artifact: d.artifact, rev: d.rev } : {}) });
        break;
      }
      case 'extension_ui_request':
        if (ev.method === 'select' && ev.id != null) {
          this.store.append(run.id, 'approval.requested', { ask: ev.id, title: clip(String(ev.title || ''), 500), options: ev.options || [] });
          this.notify(run);
        } else if (ev.method === 'cancel') {
          this.store.append(run.id, 'approval.resolved', { ask: ev.targetId, answer: 'cancelled' });
          setImmediate(() => this.store.has(run.id) && this.notify(run));
        }
        break;
      case 'agent_end': {
        if (ev.isTerminal === false) break;
        session();
        const result = { status: ev.status, durationMs: ev.durationMs, turns: ev.turns, toolCalls: ev.toolCalls, usage: ev.usage, ...(ev.cost != null ? { cost: ev.cost } : {}) };
        if (ev.status === 'aborted') this.store.setStatus(run.id, 'stopped', { result });
        else if (ev.status === 'error') this.store.setStatus(run.id, 'failed', { result, error: clip(String(ev.errorMessage || 'The agent stopped with an error.'), 600) });
        else if (run.phase === 'plan') this.store.setStatus(run.id, run.artifacts.plan ? 'awaiting_plan' : 'question', { result });
        else this.store.setStatus(run.id, 'review', { result });
        setImmediate(() => this.store.has(run.id) && this.notify(run)); // after the server cleared the answered questions
        break;
      }
      default:
    }
  }

  /** Your answer to one of the agent's questions (an approval), for the log. */
  onReply(proc, msg) {
    const id = proc?.runId;
    if (!id || !this.store.has(id) || msg?.id == null) return;
    this.store.append(id, 'approval.resolved', { ask: msg.id, answer: msg.cancelled ? 'cancelled' : clip(String(msg.value ?? ''), 80) });
    setImmediate(() => this.store.has(id) && this.notify(this.store.get(id)));
  }

  /** A conversation opened from its saved file may belong to a run: connect them, so the run keeps recording. */
  adopt(proc) {
    const file = proc.opts?.resume;
    if (!file || proc.runId) return;
    const run = this.store.list().find((r) => r.sessionFile === file && !FINAL.has(r.status));
    if (run && !this.live.has(run.id)) this.attach(run, proc);
  }

  /** The agent of a run, started again from its saved conversation when it is not running. */
  async ensureProc(run) {
    const live = this.live.get(run.id);
    if (live && !live.exited) return live;
    const wt = run.worktree;
    if (!wt || !fs.existsSync(this.s.backend.hostPath(wt.path))) throw bad(`This run's worktree folder is gone (${wt?.path || 'unknown'}), so the agent cannot continue. You can discard the run.`, 409);
    const open = [...this.s.procs.values()].find((p) => run.sessionFile && (p.opts.resume === run.sessionFile || p.session?.file === run.sessionFile));
    const proc = open || (await this.s.startProc(run.sessionFile && fs.existsSync(run.sessionFile) ? { workspace: run.workspace, resume: run.sessionFile, model: run.model ? `${run.provider ? run.provider + '/' : ''}${run.model}` : undefined } : { workspace: run.workspace, worktree: wt }));
    this.attach(run, proc);
    return proc;
  }

  idle(run) {
    const proc = this.live.get(run.id);
    if (proc?.streaming) throw bad('The agent is still working. Stop it or wait until it is done.', 409);
    return proc;
  }

  // ---- Plan --------------------------------------------------------------------------------------------------------

  async approvePlan(id, { commands = false } = {}) {
    const run = this.store.get(id);
    if (run.phase !== 'plan' || !run.artifacts.plan) throw bad('There is no plan to approve yet.', 409);
    if (!['awaiting_plan', 'stopped', 'question'].includes(run.status)) throw bad('This run is not waiting for a plan approval.', 409);
    this.idle(run);
    const proc = await this.ensureProc(run);
    const rev = run.artifacts.plan.rev;
    const notes = this.store.pendingComments(id);
    run.phase = 'execute';
    run.scope = { edits: true, commands: !!commands, planRev: rev, at: Date.now() };
    this.store.save(run);
    this.store.append(id, 'plan.approved', { rev, scope: { edits: true, commands: !!commands }, worktree: run.worktree?.path || '' });
    this.applyScope(run, proc);
    proc._persistRaw({ type: 'plan', on: false });
    const sent = this.store.markCommentsSent(id);
    const text = [`The plan (revision ${rev}) is approved. Implement it now.`, run.scope.commands ? 'You may edit files and run commands inside this worktree without asking; anything destructive or outside it still asks.' : 'You may edit files inside this worktree without asking; commands still ask.', ...(notes.length ? ['', 'Notes from the review, to take into account:', ...commentLines(notes)] : [])].join('\n');
    if (sent.length) this.store.append(id, 'feedback.sent', { comments: sent, text: '' });
    await proc.request({ type: 'prompt', message: text });
    this.notify(run);
    return this.view(run);
  }

  // ---- Feedback ----------------------------------------------------------------------------------------------------

  async feedback(id, text) {
    const run = this.store.get(id);
    if (FINAL.has(run.status)) throw bad('This run is finished.', 409);
    const body = String(text || '').trim();
    const notes = this.store.pendingComments(id);
    if (!body && !notes.length) throw bad('Write some feedback or add a comment first.');
    const proc = await this.ensureProc(run);
    const planning = run.phase === 'plan';
    const message = [
      body || 'Please address these comments.',
      ...(notes.length ? ['', 'Comments:', ...commentLines(notes)] : []),
      '',
      planning ? 'Revise the plan: save the complete new revision with artifact(kind="plan"), then stop and wait for approval.' : 'Make the changes, verify them again, and save an updated walkthrough.',
    ].join('\n');
    const sent = this.store.markCommentsSent(id);
    this.store.append(id, 'feedback.sent', { text: clip(body, 600), comments: sent });
    // While the agent works, the message is queued and it reads it at its next step.
    await proc.request({ type: 'prompt', message, streamingBehavior: 'steer' });
    this.notify(run);
    return this.view(run);
  }

  // ---- Review: apply, keep, discard --------------------------------------------------------------------------------

  /** What the changes still to review are compared with: the base, or what was applied part by part so far. */
  from(run) {
    return run.accepted?.base || run.worktree.base;
  }

  /**
   * The changes still to apply. `tree` is a snapshot of the worktree now: pass it back with a file's diff and with an
   * apply of chosen hunks, so the hunks you picked are the hunks that are applied.
   */
  async diff(id) {
    const run = this.store.get(id);
    const wt = run.worktree;
    if (!wt) throw bad('This run has no worktree.', 409);
    if (run.status === 'discarded') return { files: [], commits: 0, pending: false, ahead: 0, main: null, gone: true };
    const b = this.s.backend;
    const [d, snap, main] = await Promise.all([gitapi.branchDiff(b, wt.path, wt.base, { baseBranch: wt.baseBranch }), gitapi.snapshotDiff(b, wt.path, this.from(run)), gitapi.mainState(b, wt.repo).catch(() => null)]);
    return { ...d, files: snap.files, tree: snap.tree, applied: run.accepted?.parts || [], main };
  }

  async fileDiff(id, file, untracked, tree = '') {
    const run = this.store.get(id);
    const wt = run.worktree;
    if (!wt) throw bad('This run has no worktree.', 409);
    const t = /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(tree || '')) ? tree : await gitapi.snapshotTree(this.s.backend, wt.path);
    return { ...(await gitapi.treeFileDiff(this.s.backend, wt.path, this.from(run), t, file)), tree: t };
  }

  /** Session bookkeeping shared by apply, keep and discard: the conversation file remembers what became of its branch. */
  mark(run, state, hash = '') {
    const proc = this.live.get(run.id);
    if (proc && !proc.exited) proc.setWorktreeState(state, { hash });
    else if (run.sessionFile && fs.existsSync(run.sessionFile)) {
      appendEntry(run.sessionFile, { type: 'worktree', state, hash, at: Date.now() });
      closeSession(run.sessionFile);
    }
  }

  /**
   * Apply the run's changes to the branch it started from. With no choice (and nothing applied before) the run's
   * branch is merged. With `files` (paths) and optionally `hunks` ({ path: [hunk numbers] }), only those parts are
   * applied as one commit; the rest stays in the worktree, and the run stays open until it is applied, kept or
   * discarded. `tree` is the snapshot the choice was made on (from diff()); picked hunks are refused if it moved.
   */
  async apply(id, { files = null, hunks = null, tree = '' } = {}) {
    const run = this.store.get(id);
    if (FINAL.has(run.status)) throw bad('This run is already finished.', 409);
    if (run.phase === 'plan') throw bad('Nothing was changed yet: the plan has not been approved.', 409);
    this.idle(run);
    if (files != null || hunks != null || run.accepted) return this.applySome(run, { files, hunks, tree });
    const wt = run.worktree;
    const d = await gitapi.branchDiff(this.s.backend, wt.path, wt.base, { baseBranch: wt.baseBranch });
    if (!d.files.length && !d.commits) throw bad('This run changed nothing, so there is nothing to apply.', 409);
    let r;
    try {
      r = await gitapi.merge(this.s.backend, { repo: wt.repo, wt: wt.path, slug: wt.slug, baseBranch: wt.baseBranch, message: `${run.title} (ORBIX run ${run.id})`, changed: d.files.map((f) => f.path) });
    } catch (e) {
      this.store.append(id, 'apply.refused', { reason: clip(e?.message || String(e), 500) });
      throw e;
    }
    if (!r.merged) {
      this.store.append(id, 'apply.conflict', { files: r.files });
      this.notify(run);
      return { applied: false, conflict: true, files: r.files, run: this.view(run) };
    }
    this.mark(run, 'merged', r.hash);
    this.store.append(id, 'apply.done', { hash: r.hash, branch: wt.baseBranch, files: d.files.length });
    this.store.setStatus(id, 'applied', { applied: { hash: r.hash, at: Date.now(), branch: wt.baseBranch, files: d.files.length } });
    this.s.broadcastProcs();
    this.notify(run);
    return { applied: true, hash: r.hash, run: this.view(run) };
  }

  async applySome(run, { files, hunks, tree }) {
    const id = run.id;
    const wt = run.worktree;
    const b = this.s.backend;
    const from = this.from(run);
    const snap = await gitapi.snapshotDiff(b, wt.path, from);
    if (!snap.files.length) throw bad(run.accepted ? 'Everything this run changed has been applied already.' : 'This run changed nothing, so there is nothing to apply.', 409);
    const changed = new Set(snap.files.map((f) => f.path));
    const paths = files == null ? [...changed] : [...new Set((Array.isArray(files) ? files : []).map((p) => String(p ?? '').replace(/\\/g, '/')))];
    if (!paths.length) throw bad('Choose at least one file to apply.');
    const unknown = paths.filter((p) => !changed.has(p));
    if (unknown.length) throw bad(`${unknown.slice(0, 3).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not among the changes still to apply. Look at the changes again.`, 409);
    const pick = {};
    for (const [p, list] of Object.entries(hunks && typeof hunks === 'object' ? hunks : {})) {
      if (!paths.includes(p)) continue;
      if (!Array.isArray(list) || list.some((n) => !Number.isInteger(n) || n < 0 || n > 10000)) throw bad(`The hunks chosen for ${p} are not valid.`);
      pick[p] = [...new Set(list)].sort((x, y) => x - y);
    }
    if (Object.keys(pick).length && tree !== snap.tree) throw bad('The run’s files changed after you chose the hunks. Look at the changes again, then apply.', 409);
    const part = files == null && !Object.keys(pick).length ? 'all' : 'some';
    let r;
    try {
      r = await gitapi.applyPartial(b, { repo: wt.repo, wt: wt.path, slug: wt.slug, baseBranch: wt.baseBranch, from, tree: snap.tree, paths, hunks: pick, message: `${run.title} (ORBIX run ${id}${part === 'some' ? `, part: ${paths.length} file${paths.length === 1 ? '' : 's'}` : ''})` });
    } catch (e) {
      this.store.append(id, 'apply.refused', { reason: clip(e?.message || String(e), 500), files: paths });
      throw e;
    }
    if (!r.applied) {
      this.store.append(id, 'apply.conflict', { files: r.files, chosen: paths });
      this.notify(run);
      return { applied: false, conflict: true, files: r.files, run: this.view(run) };
    }
    const left = (await gitapi.snapshotDiff(b, wt.path, r.accepted, { tree: snap.tree })).files.map((f) => f.path);
    const entry = { hash: r.hash, at: Date.now(), branch: wt.baseBranch, files: paths, ...(Object.keys(pick).length ? { hunks: pick } : {}) };
    run.accepted = { base: r.accepted, parts: [...(run.accepted?.parts || []), entry] };
    this.store.save(run);
    this.store.append(id, 'apply.partial', { hash: r.hash, branch: wt.baseBranch, files: paths, ...(entry.hunks ? { hunks: entry.hunks } : {}), remaining: left });
    if (!left.length) {
      // Everything is in the base branch now: the run is applied, as with a whole apply.
      const all = new Set(run.accepted.parts.flatMap((x) => x.files));
      this.mark(run, 'merged', r.hash);
      await gitapi.dropAccepted(b, wt.repo, wt.slug).catch(() => {});
      this.store.append(id, 'apply.done', { hash: r.hash, branch: wt.baseBranch, files: all.size, parts: run.accepted.parts.length });
      this.store.setStatus(id, 'applied', { applied: { hash: r.hash, at: Date.now(), branch: wt.baseBranch, files: all.size, parts: run.accepted.parts.length } });
      this.s.broadcastProcs();
    }
    this.notify(run);
    return { applied: true, partial: left.length > 0, hash: r.hash, files: paths, remaining: left, run: this.view(run) };
  }

  async keep(id) {
    const run = this.store.get(id);
    if (FINAL.has(run.status)) throw bad('This run is already finished.', 409);
    this.idle(run);
    if (run.accepted && run.worktree) await gitapi.dropAccepted(this.s.backend, run.worktree.repo, run.worktree.slug).catch(() => {});
    this.mark(run, 'kept');
    this.store.setStatus(id, 'kept');
    this.notify(run);
    return this.view(run);
  }

  async discard(id) {
    const run = this.store.get(id);
    if (run.status === 'applied' || run.status === 'discarded') throw bad('This run is already finished.', 409);
    const proc = this.live.get(run.id);
    if (proc && !proc.exited) {
      proc.worktreeState = { state: 'discarded', hash: '', at: Date.now() }; // the exit handler must not look at the folder
      this.live.delete(run.id);
      await proc.stop(3000); // nothing may run in the folder while it is removed
    }
    if (run.worktree) await gitapi.worktreeRemove(this.s.backend, run.worktree);
    if (run.sessionFile && fs.existsSync(run.sessionFile)) {
      appendEntry(run.sessionFile, { type: 'worktree', state: 'discarded', hash: '', at: Date.now() });
      closeSession(run.sessionFile);
    }
    this.store.append(id, 'discard.done', { branch: run.worktree?.branch || '' });
    this.store.setStatus(id, 'discarded');
    this.notify(run);
    return this.view(run);
  }

  async stop(id) {
    const run = this.store.get(id);
    const proc = this.live.get(run.id);
    if (!proc || !proc.streaming) throw bad('This run is not working right now.', 409);
    this.store.append(id, 'run.stop_requested', {});
    await proc.request({ type: 'abort' });
    return this.view(run);
  }

  // ---- Recovery ----------------------------------------------------------------------------------------------------

  /**
   * Continue a run that was cut off. When actions with side effects were in flight, their outcome is unknown: the
   * call is refused (409, with the list) until you pass `acknowledge`, and the agent is told to check the state
   * first instead of repeating them.
   */
  async resume(id, { acknowledge = false } = {}) {
    const run = this.store.get(id);
    if (!['interrupted', 'stopped', 'failed'].includes(run.status)) throw bad('This run does not need to be resumed.', 409);
    const pending = run.status === 'interrupted' ? (run.interrupted?.pending || []).filter((p) => p.sideEffect) : [];
    if (pending.length && !acknowledge) throw bad('Some actions were still running when ORBIX stopped, so their outcome is unknown.', 409, { pending });
    const proc = await this.ensureProc(run);
    this.store.append(id, 'recover.acknowledged', { calls: pending.map((p) => p.call) });
    const lines =
      run.status === 'interrupted'
        ? [
            'ORBIX was closed while you were working on this run, and has now been restarted. Your last step may not have finished.',
            ...(pending.length ? ['', 'These actions were in flight, and it is unknown whether they completed:', ...pending.map((p) => `- ${p.name}${p.detail ? `: ${p.detail}` : ''}`), '', 'Do not repeat them blindly. First inspect the current state (git status, the files involved, any output they would have produced), then continue from where things actually are.'] : ['', 'Check the current state of the worktree (git status), then continue from where you were.']),
          ]
        : ['Continue this run from where it stopped. Check the current state of the worktree first.'];
    if (run.phase === 'plan') lines.push('', 'You are still in the planning phase: finish the plan and save it with artifact(kind="plan").');
    this.store.update(id, { interrupted: null });
    await proc.request({ type: 'prompt', message: lines.join('\n') });
    this.notify(run);
    return this.view(run);
  }

  /** Remove a finished run's record. Its conversation and any kept branch stay. */
  remove(id) {
    const run = this.store.get(id);
    if (!FINAL.has(run.status)) throw bad('Apply, keep or discard this run first.', 409);
    this.store.remove(id);
    this.s.broadcast({ g: 'run_removed', id });
  }
}

/** The HTTP API of runs. Apply and discard need `confirm: true`, which the UI sends only after you said yes. */
export function runRoutes(s) {
  const R = () => s.runs;
  const need = (ok, what) => {
    if (!ok) throw bad(`${what} needs your confirmation.`);
  };
  return {
    'GET /api/runs': async () => ({ runs: R().list() }),
    'GET /api/run': async ({ q }) => ({ run: R().view(R().store.get(q.id)), events: R().store.events(q.id, { after: Number(q.after) || 0 }) }),
    'GET /api/run/artifact': async ({ q }) => ({ artifact: R().store.readArtifact(q.id, String(q.kind || ''), q.rev) }),
    'GET /api/run/diff': async ({ q }) => R().diff(q.id),
    'GET /api/run/diff/file': async ({ q }) => ({ diff: await R().fileDiff(q.id, q.file, q.untracked === '1', q.tree) }),
    'POST /api/runs/start': async ({ body }) => ({ run: await R().start({ workspace: body.workspace, task: body.task, mode: body.mode === 'direct' ? 'direct' : 'plan', model: body.model }) }),
    'POST /api/run/approve': async ({ body }) => (need(body.confirm === true, 'Approving the plan'), { run: await R().approvePlan(body.id, { commands: body.commands === true }) }),
    'POST /api/run/feedback': async ({ body }) => ({ run: await R().feedback(body.id, body.text) }),
    'POST /api/run/comment': async ({ body }) => {
      const comment = R().store.addComment(body.id, { target: body.target, rev: body.rev, quote: body.quote, text: body.text, line: body.line, lineEnd: body.lineEnd, side: body.side });
      const run = R().store.get(body.id);
      R().notify(run);
      return { comment, run: R().view(run) };
    },
    'POST /api/run/comment/remove': async ({ body }) => {
      R().store.removeComment(body.id, String(body.comment || ''));
      const run = R().store.get(body.id);
      R().notify(run);
      return { run: R().view(run) };
    },
    'POST /api/run/apply': async ({ body }) => (need(body.confirm === true, 'Applying the changes'), R().apply(body.id, { files: Array.isArray(body.files) ? body.files : null, hunks: body.hunks && typeof body.hunks === 'object' ? body.hunks : null, tree: String(body.tree || '') })),
    'POST /api/run/keep': async ({ body }) => ({ run: await R().keep(body.id) }),
    'POST /api/run/discard': async ({ body }) => (need(body.confirm === true, 'Discarding the run'), { run: await R().discard(body.id) }),
    'POST /api/run/stop': async ({ body }) => ({ run: await R().stop(body.id) }),
    'POST /api/run/resume': async ({ body }) => ({ run: await R().resume(body.id, { acknowledge: body.acknowledge === true }) }),
    'POST /api/run/open': async ({ body }) => {
      const run = R().store.get(body.id);
      if (run.status === 'discarded') throw bad('This run was discarded with its worktree, so its agent cannot be opened again.', 409);
      const proc = await R().ensureProc(run);
      return { run: R().view(run), proc: { id: proc.id, workspace: proc.workspace } };
    },
    'POST /api/run/delete': async ({ body }) => (R().remove(body.id), {}),
  };
}
