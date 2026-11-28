// Runs: one task, from its description to reviewed changes. Everything a run did is kept in the data folder:
//
//   data/runs/<id>/run.json                 the run's current state (rewritten atomically)
//   data/runs/<id>/events.jsonl             the event log, append-only: tool calls and results, approvals and your
//                                           answers, plan and artifact revisions, comments, checks, apply or discard
//   data/runs/<id>/artifacts/<kind>/r<n>.md every revision of every artifact (plan, tasks, walkthrough, tests, note)
//
// The log is the record: run.json can be rebuilt from it, and after a restart it tells which actions were still in
// flight (a call with no result) so nothing is repeated without you knowing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdirp, readJson, writeJson, clip, replaceFile } from './util.mjs';

/** While a run is in one of these states an agent is working on it. */
export const WORKING = new Set(['planning', 'executing']);
/** States that wait for you. */
const NEEDS_YOU = new Set(['awaiting_plan', 'question', 'review', 'interrupted', 'failed', 'stopped']);
/** States after which nothing more happens. */
export const FINAL = new Set(['applied', 'kept', 'discarded']);
const STATUSES = new Set([...WORKING, ...NEEDS_YOU, ...FINAL]);

/** Artifact kinds, with who writes them and what the UI calls them. */
export const ARTIFACTS = {
  plan: { title: 'Implementation plan', by: 'agent' },
  tasks: { title: 'Task list', by: 'agent' },
  walkthrough: { title: 'Walkthrough', by: 'agent' },
  note: { title: 'Note', by: 'agent' },
  tests: { title: 'Test log', by: 'orbix' },
};
const MAX_ARTIFACT = 400_000; // characters in one revision
const MAX_COMMENT = 4000;
const ID_RE = /^r[0-9a-z]{6,40}$/;

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function newRunId() {
  return `r${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

export class RunStore {
  constructor(dir) {
    this.dir = dir;
    this.runs = new Map();
    this.seq = new Map(); // run id -> last event number
    this.load();
  }

  load() {
    this.runs.clear();
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {}
    for (const id of names) {
      if (!ID_RE.test(id)) continue;
      const run = readJson(path.join(this.dir, id, 'run.json'), null);
      if (!run || run.id !== id || !STATUSES.has(run.status)) continue;
      this.runs.set(id, run);
    }
  }

  folder(id) {
    if (!ID_RE.test(String(id))) throw bad('That run does not exist', 404);
    return path.join(this.dir, id);
  }

  get(id) {
    const run = this.runs.get(String(id));
    if (!run) throw bad('That run does not exist', 404);
    return run;
  }

  has(id) {
    return this.runs.has(String(id));
  }

  /** Newest first. */
  list() {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  create({ project, task, mode = 'plan', title = '', model = '', provider = '', parentId = '' }) {
    const text = String(task || '').trim();
    if (!text) throw bad('Describe the task first.');
    if (!project) throw bad('A project folder is required.');
    const id = newRunId();
    const now = Date.now();
    const run = {
      id,
      version: 1,
      project,
      title: title || clip(text.split('\n')[0], 80),
      task: text,
      mode: mode === 'direct' ? 'direct' : 'plan',
      status: mode === 'direct' ? 'executing' : 'planning',
      phase: mode === 'direct' ? 'execute' : 'plan',
      model,
      provider,
      parentId: parentId || '',
      workspace: '',
      worktree: null,
      sessionFile: '',
      sessionId: '',
      scope: null,
      artifacts: {},
      comments: [],
      checks: null,
      result: null,
      error: '',
      createdAt: now,
      updatedAt: now,
    };
    mkdirp(this.folder(id));
    this.runs.set(id, run);
    this.save(run);
    this.append(id, 'run.created', { task: text, mode: run.mode, project });
    return run;
  }

  save(run) {
    run.updatedAt = Date.now();
    writeJson(path.join(this.folder(run.id), 'run.json'), run);
    return run;
  }

  update(id, patch) {
    const run = this.get(id);
    Object.assign(run, patch);
    return this.save(run);
  }

  /** Move a run to `status`, recording the change once. */
  setStatus(id, status, extra = {}) {
    if (!STATUSES.has(status)) throw bad(`Unknown run state "${status}"`);
    const run = this.get(id);
    if (run.status === status && !Object.keys(extra).length) return run;
    const from = run.status;
    Object.assign(run, extra, { status });
    this.save(run);
    this.append(id, 'run.status', { from, to: status, ...(extra.error ? { error: extra.error } : {}) });
    return run;
  }

  _lastSeq(id) {
    if (this.seq.has(id)) return this.seq.get(id);
    let n = 0;
    try {
      const text = fs.readFileSync(path.join(this.folder(id), 'events.jsonl'), 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          n = Math.max(n, JSON.parse(line).seq || 0);
        } catch {} // a line cut by a crash: the next event starts on its own line (see append)
      }
    } catch {}
    this.seq.set(id, n);
    return n;
  }

  /** Add one event to the run's log and return it. Written with a single call, so events never interleave. */
  append(id, type, data = {}) {
    const file = path.join(this.folder(id), 'events.jsonl');
    const seq = this._lastSeq(id) + 1;
    const ev = { seq, at: Date.now(), type, ...data };
    let lead = '';
    try {
      // A crash can leave a half-written last line; start on a fresh line so this event stays readable.
      const size = fs.statSync(file).size;
      if (size) {
        const fd = fs.openSync(file, 'r');
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        fs.closeSync(fd);
        if (last[0] !== 0x0a) lead = '\n';
      }
    } catch {}
    fs.appendFileSync(file, lead + JSON.stringify(ev) + '\n');
    this.seq.set(id, seq);
    return ev;
  }

  /** Events after `after` (an event number), oldest first. Unreadable lines are skipped. */
  events(id, { after = 0 } = {}) {
    const out = [];
    let text = '';
    try {
      text = fs.readFileSync(path.join(this.folder(id), 'events.jsonl'), 'utf8');
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.seq > after) out.push(ev);
      } catch {}
    }
    return out;
  }

  // ---- Artifacts ---------------------------------------------------------------------------------------------------

  /** Save a new revision of an artifact. Identical content to the latest revision is not saved twice. */
  writeArtifact(id, { kind, title = '', content, author = 'agent' }) {
    if (!Object.hasOwn(ARTIFACTS, kind)) throw bad(`Unknown artifact "${kind}". Use one of: ${Object.keys(ARTIFACTS).join(', ')}.`);
    const text = String(content ?? '').replace(/\r\n/g, '\n');
    if (!text.trim()) throw bad('The artifact has no content.');
    if (text.length > MAX_ARTIFACT) throw bad(`The artifact is too long (${text.length} characters; the limit is ${MAX_ARTIFACT}).`);
    const run = this.get(id);
    const cur = run.artifacts[kind];
    if (cur && this.readArtifact(id, kind, cur.rev).content === text) return { kind, rev: cur.rev, unchanged: true };
    const rev = (cur?.rev || 0) + 1;
    const dir = mkdirp(path.join(this.folder(id), 'artifacts', kind));
    const file = path.join(dir, `r${rev}.md`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    replaceFile(tmp, file);
    run.artifacts[kind] = { kind, rev, title: clip(String(title || '').trim(), 120) || ARTIFACTS[kind].title, author, at: Date.now(), size: text.length };
    this.save(run);
    this.append(id, 'artifact.revised', { kind, rev, author, size: text.length });
    return { kind, rev };
  }

  readArtifact(id, kind, rev) {
    if (!Object.hasOwn(ARTIFACTS, kind)) throw bad('Unknown artifact', 404);
    const run = this.get(id);
    const meta = run.artifacts[kind];
    if (!meta) throw bad('This run has no such artifact yet', 404);
    const n = rev == null || rev === '' ? meta.rev : Number(rev);
    if (!Number.isInteger(n) || n < 1 || n > meta.rev) throw bad('That revision does not exist', 404);
    const content = fs.readFileSync(path.join(this.folder(id), 'artifacts', kind, `r${n}.md`), 'utf8');
    return { ...meta, rev: n, latest: meta.rev, content };
  }

  // ---- Comments ----------------------------------------------------------------------------------------------------

  /** A comment on an artifact revision (optionally on a quoted passage) or on a changed file. */
  addComment(id, { target, rev = 0, quote = '', text }) {
    const body = String(text || '').trim();
    if (!body) throw bad('Write the comment first.');
    if (body.length > MAX_COMMENT) throw bad('That comment is too long.');
    const t = String(target || '');
    if (!t || t.length > 400) throw bad('A comment needs something to be about.');
    const run = this.get(id);
    const c = { id: `c${crypto.randomBytes(5).toString('hex')}`, target: t, rev: Number(rev) || 0, quote: clip(String(quote || ''), 600), text: body, at: Date.now(), sent: false };
    run.comments.push(c);
    this.save(run);
    this.append(id, 'comment.added', { comment: c.id, target: t, rev: c.rev, text: clip(body, 400) });
    return c;
  }

  removeComment(id, commentId) {
    const run = this.get(id);
    const i = run.comments.findIndex((c) => c.id === commentId && !c.sent);
    if (i < 0) throw bad('That comment was already sent or does not exist', 404);
    run.comments.splice(i, 1);
    this.save(run);
    this.append(id, 'comment.removed', { comment: commentId });
  }

  /** Comments not yet given to the agent. */
  pendingComments(id) {
    return this.get(id).comments.filter((c) => !c.sent);
  }

  markCommentsSent(id) {
    const run = this.get(id);
    const ids = [];
    for (const c of run.comments) if (!c.sent) (c.sent = true), ids.push(c.id);
    if (ids.length) this.save(run);
    return ids;
  }

  // ---- Recovery ----------------------------------------------------------------------------------------------------

  /** Tool calls that started and never reported a result: what was in flight when the run stopped being recorded. */
  inFlight(id) {
    const open = new Map();
    for (const ev of this.events(id)) {
      if (ev.type === 'tool.call') open.set(ev.call, ev);
      else if (ev.type === 'tool.result') open.delete(ev.call);
      else if (ev.type === 'recover.acknowledged') open.clear();
    }
    return [...open.values()].map((ev) => ({ call: ev.call, name: ev.name, detail: ev.detail || '', sideEffect: !!ev.sideEffect, at: ev.at }));
  }

  /**
   * After a start: every run that was still working when ORBIX last stopped becomes `interrupted`. `live` holds the
   * ids of runs an agent is attached to right now (none at start-up). Returns the runs that changed.
   */
  reconcile(live = new Set()) {
    const changed = [];
    for (const run of this.runs.values()) {
      if (!WORKING.has(run.status) || live.has(run.id)) continue;
      const pending = this.inFlight(run.id);
      const was = run.status;
      run.interrupted = { was, phase: run.phase, at: Date.now(), pending };
      run.status = 'interrupted';
      this.save(run);
      this.append(run.id, 'recover.interrupted', { was, pending: pending.map((p) => ({ call: p.call, name: p.name, detail: p.detail, sideEffect: p.sideEffect })) });
      changed.push(run);
    }
    return changed;
  }

  remove(id) {
    const dir = this.folder(id);
    this.get(id);
    this.runs.delete(id);
    this.seq.delete(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
