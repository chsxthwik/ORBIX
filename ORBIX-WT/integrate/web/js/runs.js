// Runs and Review: the two hub views beside Home.
//   Runs    every run across your projects, what each is doing, a box to start one, and the scheduled runs
//           (schedules.js)
//   Review  one queue of everything that waits for you: approvals, plans, finished changes, interrupted runs
//   a run   its timeline (each step links to its output, diff or document), the plan, the changes, the test log
//           and the walkthrough, with comments, feedback and the decision that is yours to make
import { h, icon, iconBtn, replace, toast, timeAgo, baseName, spinner, skeleton, errorState, fmtDuration, debounce } from './dom.js';
import { api } from './api.js';
import { S, on, emit, setActive, replyUi } from './store.js';
import { modal, btn, confirmDialog, popMenu, isApproval } from './dialogs.js';
import { renderMarkdown } from './markdown.js';
import { renderUnifiedDiff, statChips } from './tools.js';
import { schedulesSection, onScheduleEvent, initSchedules } from './schedules.js';

const el = () => document.getElementById('runs');
const runs = new Map(); // id -> run (as the server sends it)
let loaded = false;
let loadError = '';
let hub = null; // null | { view: 'runs' | 'review' | 'run', id }
const handlers = { openProc: null };
const WORKING = new Set(['planning', 'executing']);
const FINAL = new Set(['applied', 'kept', 'discarded']);

const STATUS = {
  planning: { label: 'Planning', cls: 'live', hint: 'The agent is reading the code and writing a plan.' },
  awaiting_plan: { label: 'Plan to review', cls: 'you', hint: 'Read the plan, then approve it or ask for changes.' },
  question: { label: 'Asked you a question', cls: 'you', hint: 'The agent needs an answer before it can plan.' },
  executing: { label: 'Working', cls: 'live', hint: 'The agent is changing files in the run’s worktree.' },
  review: { label: 'Changes to review', cls: 'you', hint: 'Read the changes, then apply or discard them.' },
  stopped: { label: 'Stopped', cls: 'idle', hint: 'You stopped this run. It can continue from where it was.' },
  failed: { label: 'Failed', cls: 'err', hint: 'The agent stopped with an error.' },
  interrupted: { label: 'Interrupted', cls: 'err', hint: 'ORBIX closed while this run was working.' },
  applied: { label: 'Applied', cls: 'done', hint: 'The changes are in your project.' },
  kept: { label: 'Branch kept', cls: 'done', hint: 'The branch was kept for you to handle with git.' },
  discarded: { label: 'Discarded', cls: 'done', hint: 'The worktree and its branch were removed.' },
};
const ART = { plan: 'Plan', tasks: 'Tasks', walkthrough: 'Walkthrough', tests: 'Test log', note: 'Note' };
/** A changed file, with the lines a comment is about: `src/a.js:12` or `src/a.js:12-14`. */
const where = (c) => (c.line ? `${c.target}:${c.line}${c.lineEnd && c.lineEnd !== c.line ? `-${c.lineEnd}` : ''}` : c.target);

export const hubView = () => hub;
export const isHub = () => !!hub;
export function initRuns(h_) {
  Object.assign(handlers, h_);
  initSchedules(() => hub && hub.view === 'runs' && drawSoon());
  refresh();
}

/** What waits for you, across every run: the Review queue and the number beside it. */
function reviewItems() {
  const out = [];
  const runProcs = new Set();
  for (const r of runs.values()) {
    if (r.procId) runProcs.add(r.procId);
    for (const a of r.asks || []) out.push({ kind: 'ask', run: r, ask: a, at: r.updatedAt });
    if (['awaiting_plan', 'question', 'review', 'interrupted', 'failed'].includes(r.status)) out.push({ kind: r.status, run: r, at: r.updatedAt });
  }
  // Conversations that wait for an approval are decisions too (a run's own conversation is listed through its run).
  for (const t of S.tabs.values()) {
    if (t.dead || runProcs.has(t.id)) continue;
    for (const d of t.dialogs || []) if (isApproval(d)) out.push({ kind: 'conv-ask', tab: t, ask: d, at: Date.now() });
  }
  // Approvals first (an agent is blocked on them), then the newest.
  const urgent = (it) => (it.kind === 'ask' || it.kind === 'conv-ask' ? 1 : 0);
  return out.sort((a, b) => urgent(b) - urgent(a) || b.at - a.at);
}
export const reviewCount = () => reviewItems().length;
export const workingCount = () => [...runs.values()].filter((r) => WORKING.has(r.status)).length;

async function refresh() {
  try {
    const j = await api.get('/api/runs');
    runs.clear();
    for (const r of j.runs) runs.set(r.id, r);
    loaded = true;
    loadError = '';
  } catch (e) {
    loadError = e.message;
  }
  emit('runs');
  draw();
}

/** A run changed on the server (or was removed). */
export function onRunEvent(g) {
  if (g.g === 'schedule' || g.g === 'schedule_removed') return onScheduleEvent(g);
  if (g.g === 'run_removed') runs.delete(g.id);
  else if (g.run) runs.set(g.run.id, g.run);
  emit('runs');
  if (!hub) return;
  if (hub.view === 'run' && g.run?.id === hub.id) detail?.update(g.run);
  else if (hub.view === 'run' && g.g === 'run_removed' && g.id === hub.id) openHub('runs');
  else if (hub.view !== 'run') drawSoon();
}

export function openHub(view, id) {
  hub = view === 'run' ? { view, id } : { view: view === 'review' ? 'review' : 'runs' };
  if (!loaded) refresh();
  emit('hub');
}
export function closeHub(quiet) {
  if (!hub) return;
  hub = null;
  detail = null;
  if (!quiet) emit('hub');
}

const projName = (r) => baseName(r.project);
const pill = (status) => h('span', { class: `run-pill ${STATUS[status]?.cls || 'idle'}`, title: STATUS[status]?.hint || '' }, WORKING.has(status) ? h('span', { class: 'dot run' }) : null, STATUS[status]?.label || status);
const post = (url, body) => api.post(url, body).catch((e) => (toast(e.message, 'error', 9000), Promise.reject(e)));

// ---- Decisions (shared by the queue and the run page) --------------------------------------------------------------

/** Approving a plan: the dialog says exactly what the approval allows. */
function approveDialog(run) {
  const wt = run.worktree || {};
  let commands = false;
  const choice = (val, title, text) =>
    h('label', { class: 'scope-opt' },
      h('input', { type: 'radio', name: 'scope', checked: val === commands ? true : null, onchange: () => (commands = val) }),
      h('span', null, h('b', null, title), h('span', { class: 'muted small' }, text)));
  const m = modal({
    title: `Approve the plan (revision ${run.artifacts?.plan?.rev || 1})`,
    size: 'md',
    body: h('div', { class: 'scope' },
      h('p', null, 'The agent will start changing files. This is what your approval allows:'),
      h('dl', { class: 'scope-facts' },
        h('dt', null, 'Where'), h('dd', null, h('code', null, wt.path || run.workspace), h('span', { class: 'muted small' }, 'A separate worktree. Your own checkout is not touched until you apply the changes.')),
        h('dt', null, 'Branch'), h('dd', null, h('code', null, wt.branch || ''), wt.baseBranch ? h('span', { class: 'muted small' }, `cut from ${wt.baseBranch}`) : null)),
      h('fieldset', { class: 'scope-pick' }, h('legend', null, 'Allow without asking again'),
        choice(false, 'Edit files in the worktree', 'Every command still asks you first.'),
        choice(true, 'Edit files and run commands in the worktree', 'Tests, builds and other commands run without asking.')),
      h('p', { class: 'scope-note' }, icon('shield', 14), h('span', null, 'Always asks, whatever you choose: files outside the worktree, and commands that delete folders, push, publish, rewrite history or change the system.'))),
    actions: [btn('Cancel', () => m.close()), btn('Approve and start', async () => {
      m.close();
      await post('/api/run/approve', { id: run.id, commands, confirm: true }).catch(() => {});
    }, 'primary')],
  });
}

// What you chose to apply, per run: files left out, and hunks left out of a file (numbered as in its diff). `tree` is
// the snapshot of the worktree the hunks were counted on; the server refuses picked hunks when it has moved since.
const picks = new Map(); // run id -> { off: Set<path>, hunksOff: Map<path, Set<n>>, hunkCount: Map<path, n>, tree }
function pickOf(id) {
  if (!picks.has(id)) picks.set(id, { off: new Set(), hunksOff: new Map(), hunkCount: new Map(), tree: '' });
  return picks.get(id);
}
/** The files and hunks chosen out of `files`; `whole` when that is everything. */
function choiceOf(id, files) {
  const p = pickOf(id);
  const chosen = files.filter((f) => !p.off.has(f.path)).map((f) => f.path);
  const hunks = {};
  for (const f of chosen) {
    const off = p.hunksOff.get(f);
    const n = p.hunkCount.get(f);
    if (off?.size && n) hunks[f] = Array.from({ length: n }, (_, i) => i).filter((i) => !off.has(i));
  }
  return { chosen, hunks, whole: chosen.length === files.length && !Object.keys(hunks).length };
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Apply: every changed file has a box (all ticked); what you leave out stays in the run's worktree. */
async function applyRun(run) {
  let d;
  try {
    d = await api.get(`/api/run/diff?id=${run.id}`);
  } catch (e) {
    return toast(e.message, 'error', 8000);
  }
  const wt = run.worktree || {};
  const into = wt.baseBranch || 'your branch';
  if (!d.files.length) return toast(run.accepted ? 'Everything this run changed has been applied already.' : 'This run changed nothing, so there is nothing to apply.', 'error', 8000);
  const p = pickOf(run.id);
  const live = new Set(d.files.map((f) => f.path));
  for (const x of [...p.off]) if (!live.has(x)) p.off.delete(x);
  const list = h('div', { class: 'apply-files', role: 'group', 'aria-label': 'Files to apply' });
  const summary = h('p', { class: 'muted small' });
  const all = h('input', { type: 'checkbox', 'aria-label': 'All files', onchange: (e) => (d.files.forEach((f) => (e.target.checked ? p.off.delete(f.path) : p.off.add(f.path))), sync()) });
  let go;
  function sync() {
    const c = choiceOf(run.id, d.files);
    all.checked = c.chosen.length === d.files.length;
    all.indeterminate = c.chosen.length > 0 && c.chosen.length < d.files.length;
    replace(list, d.files.map((f) => {
      const off = p.hunksOff.get(f.path);
      const n = p.hunkCount.get(f.path);
      return h('label', { class: 'apply-file' + (p.off.has(f.path) ? ' off' : '') },
        h('input', { type: 'checkbox', checked: p.off.has(f.path) ? null : true, onchange: (e) => (e.target.checked ? p.off.delete(f.path) : p.off.add(f.path), sync()) }),
        h('span', { class: `chg-st ${f.status}` }, f.status),
        h('span', { class: 'ell grow', title: f.path }, f.path),
        off?.size && n && !p.off.has(f.path) ? h('span', { class: 'apply-hunks', title: 'Chosen in the Changes tab' }, `${n - off.size} of ${n} hunks`) : null,
        statChips(f));
    }));
    summary.textContent = c.whole
      ? `Everything is merged into ${into}. Your uncommitted work in other files stays as it is. If a file you changed would be overwritten, or the merge conflicts, nothing is changed.`
      : c.chosen.length
        ? `${plural(c.chosen.length, 'file')} ${Object.keys(c.hunks).length ? '(some only in part) ' : ''}go${c.chosen.length === 1 ? 'es' : ''} to ${into} as one commit. The rest stays in the run’s worktree: apply it later, ask for changes, or discard it. On a conflict nothing is changed.`
        : 'Choose at least one file.';
    if (go) {
      go.disabled = !c.chosen.length;
      go.textContent = c.whole ? 'Apply changes' : `Apply ${plural(c.chosen.length, 'file')}`;
    }
  }
  const send = async () => {
    const c = choiceOf(run.id, d.files);
    if (!c.chosen.length) return;
    m.close();
    try {
      const body = { id: run.id, confirm: true, ...(c.whole ? {} : { files: c.chosen, hunks: c.hunks, tree: p.tree || d.tree }) };
      const r = await api.post('/api/run/apply', body);
      if (r.applied) {
        picks.delete(run.id);
        toast(r.partial ? `Applied ${plural(r.files.length, 'file')} to ${into}. ${plural(r.remaining.length, 'file')} still to review.` : `Applied to ${into}`, 'ok');
      } else if (r.conflict) conflictDialog(run, r.files);
    } catch (e) {
      toast(e.message, 'error', 12000);
    }
  };
  go = btn('Apply changes', send, 'primary');
  const m = modal({
    title: run.accepted ? 'Apply the rest of the changes?' : 'Apply these changes?',
    size: 'md',
    body: h('div', { class: 'apply-pick' },
      h('p', null, 'Into ', h('code', null, into), ' in ', h('code', null, wt.repo || run.project)),
      run.accepted?.parts?.length ? h('p', { class: 'muted small' }, `Applied before: ${plural(new Set(run.accepted.parts.flatMap((x) => x.files)).size, 'file')} in ${plural(run.accepted.parts.length, 'part')}.`) : null,
      h('label', { class: 'apply-all' }, all, h('span', null, `${plural(d.files.length, 'changed file')}`)),
      list,
      summary),
    actions: [btn('Cancel', () => m.close()), go],
    initialFocus: go,
  });
  sync();
}

function conflictDialog(run, files) {
  const m = modal({
    title: 'These changes conflict with your branch',
    size: 'md',
    body: h('div', null,
      h('p', null, `Nothing was changed. ${files.length === 1 ? 'This file was' : 'These files were'} edited on both sides since the run started:`),
      h('ul', { class: 'conflict-files' }, files.map((f) => h('li', null, h('code', null, f)))),
      h('p', { class: 'muted small' }, 'Ask the agent to bring its branch up to date with yours and resolve the conflict, or keep the branch and merge it yourself.')),
    actions: [btn('Close', () => m.close()), btn('Ask the agent to resolve it', async () => {
      m.close();
      await post('/api/run/feedback', { id: run.id, text: `Applying your changes failed: they conflict with ${run.worktree?.baseBranch || 'the base branch'} in ${files.join(', ')}. Merge ${run.worktree?.baseBranch || 'the base branch'} into your branch inside this worktree, resolve the conflicts keeping both intents, run the checks again, and update the walkthrough.` }).catch(() => {});
    }, 'primary')],
  });
}

async function discardRun(run) {
  if (!(await confirmDialog('Discard this run?', `The worktree and its branch ${run.worktree?.branch || ''} are deleted, with every change the agent made in them. The run's record and documents stay. This cannot be undone.`, { ok: 'Discard', danger: true }))) return;
  await post('/api/run/discard', { id: run.id, confirm: true }).catch(() => {});
}

async function resumeRun(run) {
  try {
    await api.post('/api/run/resume', { id: run.id });
  } catch (e) {
    if (e.status !== 409) return toast(e.message, 'error', 9000);
    // Actions with side effects were in flight: show them, and continue only on your word.
    const pending = (run.interrupted?.pending || []).filter((p) => p.sideEffect);
    if (!pending.length) return toast(e.message, 'error', 9000);
    const m = modal({
      title: 'Some actions may not have finished',
      size: 'md',
      body: h('div', null,
        h('p', null, 'ORBIX closed while this was running, so it is unknown whether it completed:'),
        h('ul', { class: 'pending-calls' }, pending.map((p) => h('li', null, h('b', null, p.name), ' ', h('code', null, p.detail || '')))),
        h('p', { class: 'muted small' }, 'ORBIX will not run it again by itself. If you continue, the agent is told what was in flight and to check the current state before it repeats anything.')),
      actions: [btn('Cancel', () => m.close()), btn('Continue, check first', async () => {
        m.close();
        await post('/api/run/resume', { id: run.id, acknowledge: true }).catch(() => {});
      }, 'primary')],
    });
  }
}

async function answerAsk(run, ask, value) {
  await post('/api/reply', { proc: run.procId, msg: { type: 'extension_ui_response', id: ask.id, value } }).catch(() => {});
}

async function openConversation(run) {
  try {
    const j = await api.post('/api/run/open', { id: run.id });
    await handlers.openProc?.({ id: j.proc.id, workspace: j.proc.workspace, title: run.title, resume: run.sessionFile || null });
  } catch (e) {
    toast(e.message, 'error', 9000);
  }
}

/** The buttons for the decision a run is waiting on (the same in the queue and on the run page). */
function decisionButtons(run, { compact = false } = {}) {
  const sm = compact ? 'sm' : '';
  switch (run.status) {
    case 'awaiting_plan':
      return [btn('Approve plan…', () => approveDialog(run), `primary ${sm}`)];
    case 'review':
      return [btn('Apply changes…', () => applyRun(run), `primary ${sm}`), btn('Discard…', () => discardRun(run), `danger ${sm}`)];
    case 'interrupted':
      return [btn('Resume…', () => resumeRun(run), `primary ${sm}`), btn('Discard…', () => discardRun(run), `danger ${sm}`)];
    case 'failed':
    case 'stopped':
      return [btn('Continue', () => resumeRun(run), `primary ${sm}`), run.phase === 'execute' ? btn('Apply changes…', () => applyRun(run), sm) : null, btn('Discard…', () => discardRun(run), `danger ${sm}`)];
    case 'planning':
    case 'executing':
      return [btn('Stop', () => post('/api/run/stop', { id: run.id }).catch(() => {}), sm)];
    default:
      return [];
  }
}

function askCard(run, ask, answer = (o) => answerAsk(run, ask, o)) {
  return h('div', { class: 'ask-card', role: 'group', 'aria-label': 'The agent asks' },
    h('div', { class: 'ask-q' }, icon('shield', 15), h('span', { class: 'prewrap' }, ask.title)),
    h('div', { class: 'ask-opts' }, (ask.options || []).map((o) => btn(o, () => answer(o), `sm ${o === 'Deny' ? 'danger' : o === 'Allow once' ? 'primary' : ''}`))));
}

// ---- Runs board and Review queue -----------------------------------------------------------------------------------

function newRunBox() {
  const projects = S.workspaces || [];
  const last = localStorage.getItem('orbix.run.project') || '';
  let project = projects.find((p) => p.path === last)?.path || projects[0]?.path || '';
  let mode = localStorage.getItem('orbix.run.mode') === 'direct' ? 'direct' : 'plan';
  const task = h('textarea', { rows: '3', placeholder: 'Describe the task: what should change, and how you will know it works', 'aria-label': 'Task', onkeydown: (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && (e.preventDefault(), start()) });
  const go = btn('Start run', () => start(), 'primary');
  const modeBtn = (val, label, tip) => h('button', { class: 'rseg-btn' + (mode === val ? ' on' : ''), type: 'button', title: tip, 'aria-pressed': String(mode === val), onclick: (e) => {
    mode = val;
    localStorage.setItem('orbix.run.mode', val);
    for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget), b.setAttribute('aria-pressed', String(b === e.currentTarget));
  } }, label);
  // A project with extra folders: the run's worktree comes from the main folder's Git repository only.
  const extraNote = h('p', { class: 'muted small' });
  const noteFolders = () => {
    const n = projects.find((p) => p.path === project)?.folders?.length || 0;
    extraNote.hidden = !n;
    extraNote.textContent = n ? `The run works in a worktree of the main folder's Git repository. This project's ${n === 1 ? 'other folder is' : `${n} other folders are`} read-only in the run: the agent can read and search there, and a write there asks you and is not part of the changes you review or apply.` : '';
  };
  noteFolders();
  const sel = h('select', { 'aria-label': 'Project', onchange: (e) => ((project = e.target.value), localStorage.setItem('orbix.run.project', project), noteFolders()) }, projects.map((p) => h('option', { value: p.path, selected: p.path === project ? true : null }, `${p.name || baseName(p.path)}  ·  ${p.path}`)));
  async function start() {
    const text = task.value.trim();
    if (!project) return toast('Open a project folder first (the folder button in the sidebar).', 'warn');
    if (!text) return task.focus();
    go.disabled = true;
    try {
      const j = await api.post('/api/runs/start', { workspace: project, task: text, mode });
      runs.set(j.run.id, j.run);
      task.value = '';
      openHub('run', j.run.id);
    } catch (e) {
      toast(e.message, 'error', 12000);
    } finally {
      go.disabled = false;
    }
  }
  return h('section', { class: 'run-new', 'aria-label': 'Start a run' },
    h('h2', null, 'Start a run'),
    projects.length ? null : h('p', { class: 'muted small' }, 'Open a project folder first: the folder button beside Projects in the sidebar.'),
    task,
    h('div', { class: 'run-new-row' },
      projects.length ? h('label', { class: 'run-proj' }, icon('folder', 14), sel) : null,
      h('div', { class: 'rseg', role: 'group', 'aria-label': 'How to start' },
        modeBtn('plan', 'Plan first', 'The agent reads the code and writes a plan. Nothing changes until you approve it.'),
        modeBtn('direct', 'Straight to work', 'For small, clear tasks: the agent edits files in the worktree right away. Commands still ask.')),
      h('span', { class: 'grow' }),
      go),
    extraNote);
}

function runRow(r) {
  const d = r.result?.durationMs;
  return h('button', { class: 'rrow', type: 'button', onclick: () => openHub('run', r.id) },
    h('span', { class: 'rrow-main' },
      h('span', { class: 'run-title ell' }, r.title),
      h('span', { class: 'run-meta ell' }, r.unattended ? h('span', { class: 'run-sched', title: r.unattended.active ? 'Started by a schedule; runs unattended' : 'Started by a schedule' }, icon('clock', 12), 'Scheduled') : null, icon('folder', 12), projName(r), r.worktree?.branch ? [icon('branch', 12), r.worktree.branch] : null, h('span', { class: 'num' }, timeAgo(r.updatedAt)), WORKING.has(r.status) || d == null ? null : h('span', { class: 'num' }, fmtDuration(d)))),
    r.asks?.length ? h('span', { class: 'run-pill you' }, 'Needs approval') : pill(r.status));
}

function drawRuns() {
  const all = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const group = (title, list, empty) => (list.length || empty ? h('section', { class: 'run-group' }, h('h2', null, title, list.length ? h('span', { class: 'num muted' }, list.length) : null), list.length ? list.map(runRow) : h('p', { class: 'muted small' }, empty)) : null);
  const active = all.filter((r) => WORKING.has(r.status));
  const waiting = all.filter((r) => !WORKING.has(r.status) && !FINAL.has(r.status));
  const done = all.filter((r) => FINAL.has(r.status));
  replace(el(),
    h('div', { class: 'hub' },
      h('header', { class: 'hub-head' }, h('h1', null, 'Runs'), h('p', { class: 'muted' }, 'A run takes one task from its description to changes you have reviewed. Each works in its own git worktree, so several can run side by side.')),
      newRunBox(),
      schedulesSection({ runs, openRun: (id) => openHub('run', id), pill, isWorking: (st) => WORKING.has(st) }),
      loadError ? errorState(loadError, { retry: refresh }) : !loaded ? skeleton(4) : !all.length ? h('div', { class: 'empty' }, icon('activity', 22), h('span', null, 'No runs yet. Describe a task above to start one.')) : [
        group('Working now', active),
        group('Waiting for you', waiting),
        group('Finished', done.slice(0, 60)),
      ]));
}

const QUEUE = {
  awaiting_plan: 'A plan is ready for your review',
  question: 'The agent asked you a question',
  review: 'Changes are ready for your review',
  interrupted: 'Interrupted when ORBIX closed',
  failed: 'Stopped with an error',
};

function drawReview() {
  const items = reviewItems();
  replace(el(),
    h('div', { class: 'hub' },
      h('header', { class: 'hub-head' }, h('h1', null, 'Review'), h('p', { class: 'muted' }, 'Everything that waits for a decision from you, across all projects.')),
      loadError ? errorState(loadError, { retry: refresh }) : !loaded ? skeleton(4) : !items.length ? h('div', { class: 'empty' }, icon('check', 22), h('span', null, 'Nothing is waiting for you.'), workingCount() ? h('span', { class: 'small' }, `${workingCount()} run${workingCount() === 1 ? ' is' : 's are'} working.`) : null) :
        h('div', { class: 'rq' }, items.map((it) => {
          if (it.kind === 'conv-ask') {
            const t = it.tab;
            const open = () => (closeHub(true), setActive(t.id));
            return h('article', { class: 'rq-item ask' },
              h('button', { class: 'rq-head', type: 'button', onclick: open },
                h('span', { class: 'rq-what' }, 'Approval needed in a conversation'),
                h('span', { class: 'run-title ell' }, t.name || 'Conversation'),
                h('span', { class: 'run-meta ell' }, icon('folder', 12), baseName(t.worktree?.source || t.workspace))),
              askCard(null, it.ask, (o) => replyUi(t, it.ask, { value: o })));
          }
          const r = it.run;
          const head = h('button', { class: 'rq-head', type: 'button', onclick: () => openHub('run', r.id) },
            h('span', { class: 'rq-what' }, it.kind === 'ask' ? 'Approval needed' : QUEUE[it.kind]),
            h('span', { class: 'run-title ell' }, r.title),
            h('span', { class: 'run-meta ell' }, icon('folder', 12), projName(r), h('span', { class: 'num' }, timeAgo(it.at))));
          return h('article', { class: `rq-item ${it.kind === 'ask' ? 'ask' : STATUS[it.kind]?.cls || ''}` },
            head,
            it.kind === 'ask' ? askCard(r, it.ask) : null,
            it.kind === 'failed' && r.error ? h('p', { class: 'rq-err prewrap' }, r.error) : null,
            it.kind === 'interrupted' && r.interrupted?.pending?.some((p) => p.sideEffect) ? h('p', { class: 'muted small' }, `In flight when it stopped: ${r.interrupted.pending.filter((p) => p.sideEffect).map((p) => `${p.name} ${p.detail}`).join('; ')}`) : null,
            it.kind === 'ask' ? null : h('div', { class: 'rq-acts' }, it.kind === 'question' ? btn('Open and answer', () => openHub('run', r.id), 'primary sm') : decisionButtons(r, { compact: true }), btn('Open', () => openHub('run', r.id), 'ghost sm')));
        }))));
}

// ---- One run -------------------------------------------------------------------------------------------------------

let detail = null;

const TOOL_VERB = { read: 'Read', grep: 'Searched', glob: 'Listed', write: 'Wrote', edit: 'Edited', bash: 'Ran', web_fetch: 'Fetched', web_search: 'Searched the web', task: 'Delegated', todo: 'Updated its to-do list' };

/** Turn the event log into timeline rows; a call and its result are one row, an approval and its answer too. */
function timelineRows(events) {
  const rows = [];
  const calls = new Map();
  const asks = new Map();
  const scheduled = events.some((e) => e.type === 'schedule.started');
  for (const ev of events) {
    switch (ev.type) {
      case 'run.created':
        rows.push(scheduled ? { at: ev.at, kind: 'sys', icon: 'clock', text: 'A schedule started the run', sub: ev.task } : { at: ev.at, kind: 'you', icon: 'message', text: 'You started the run', sub: ev.task });
        break;
      case 'worktree.created':
        rows.push({ at: ev.at, kind: 'sys', icon: 'branch', text: `Worktree created on ${ev.branch}`, sub: ev.path });
        break;
      case 'tool.call': {
        const row = { at: ev.at, kind: 'tool', name: ev.name, icon: ev.name === 'bash' ? 'terminal' : ev.name === 'artifact' ? 'file' : ev.sideEffect ? 'pencil' : 'eye', text: ev.name === 'artifact' ? `Saving the ${ART[ev.detail]?.toLowerCase() || ev.detail}` : TOOL_VERB[ev.name] || ev.name, detail: ev.name === 'artifact' ? '' : ev.detail, pending: true, sideEffect: ev.sideEffect };
        calls.set(ev.call, row);
        rows.push(row);
        break;
      }
      case 'tool.result': {
        const row = calls.get(ev.call);
        if (!row) break;
        row.pending = false;
        row.ok = ev.ok;
        row.ms = ev.at - row.at;
        row.sub = ev.ok && row.name !== 'bash' ? '' : ev.summary;
        if (ev.exitCode != null) row.exit = ev.exitCode;
        if (ev.artifact) (row.open = { tab: ev.artifact, rev: ev.rev }), (row.text = `Saved the ${ART[ev.artifact]?.toLowerCase() || ev.artifact}, revision ${ev.rev}`);
        else if (ev.changed) row.open = { tab: 'changes', file: row.detail };
        break;
      }
      case 'approval.requested': {
        const row = { at: ev.at, kind: 'ask', icon: 'shield', text: 'Asked for your approval', sub: ev.title, pending: true };
        asks.set(ev.ask, row);
        rows.push(row);
        break;
      }
      case 'approval.resolved': {
        const row = asks.get(ev.ask);
        if (!row) break;
        row.pending = false;
        row.answer = ev.answer;
        row.ok = ev.answer !== 'Deny' && ev.answer !== 'cancelled';
        break;
      }
      case 'schedule.started':
        rows.push({ at: ev.at, kind: 'sys', icon: 'clock', text: ev.missed ? 'Unattended, for a time missed while ORBIX was closed' : 'Unattended: nothing will ask you', sub: ev.commands ? 'Allowed: file edits and commands in the worktree. Anything that would ask you is denied.' : 'Allowed: file edits in the worktree. Commands and anything that would ask you are denied.' });
        break;
      case 'policy.denied':
        rows.push({ at: ev.at, kind: 'err', icon: 'shield', ok: false, text: 'Denied: nobody was there to approve it', sub: [ev.title, ev.reason ? `why: ${ev.reason}` : ''].filter(Boolean).join(' · ') });
        break;
      case 'unattended.ended':
        rows.push({ at: ev.at, kind: 'you', icon: 'message', text: 'You took over: from now on it asks you' });
        break;
      case 'unattended.approve_failed':
        rows.push({ at: ev.at, kind: 'err', icon: 'alert', ok: false, text: 'The schedule could not approve the plan', sub: ev.error });
        break;
      case 'plan.approved':
        rows.push({ at: ev.at, kind: ev.by === 'schedule' ? 'sys' : 'you', icon: 'check', text: ev.by === 'schedule' ? `Plan revision ${ev.rev} approved by the schedule` : `You approved the plan, revision ${ev.rev}`, sub: ev.scope?.commands ? 'Allowed: file edits and commands in the worktree' : `Allowed: file edits in the worktree; commands ${ev.by === 'schedule' ? 'are denied' : 'ask'}`, open: { tab: 'plan', rev: ev.rev } });
        break;
      case 'scope.granted':
        rows.push({ at: ev.at, kind: ev.by === 'schedule' ? 'sys' : 'you', icon: 'check', text: 'Started without a plan', sub: ev.by === 'schedule' ? (ev.commands ? 'Allowed: file edits and commands in the worktree' : 'Allowed: file edits in the worktree; commands are denied') : 'Allowed: file edits in the worktree; commands ask' });
        break;
      case 'comment.added':
        rows.push({ at: ev.at, kind: 'you', icon: 'message', text: `You commented on ${ART[ev.target] ? `the ${ART[ev.target].toLowerCase()}` : where(ev)}`, sub: ev.text, open: ART[ev.target] ? { tab: ev.target, rev: ev.rev } : { tab: 'changes', file: ev.target } });
        break;
      case 'feedback.sent':
        if (ev.text || ev.comments?.length) rows.push({ at: ev.at, kind: 'you', icon: 'send', text: 'You sent feedback', sub: [ev.text, ev.comments?.length ? `${ev.comments.length} comment${ev.comments.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') });
        break;
      case 'check.result':
        rows.push({ at: ev.at, kind: 'check', icon: ev.status === 'passed' ? 'check' : 'alert', ok: ev.status === 'passed', text: ev.status === 'passed' ? 'Checks passed' : ev.status === 'failed' ? 'Checks failed' : `Checks ${ev.status}`, detail: ev.command, open: { tab: 'tests' } });
        break;
      case 'run.status':
        if (ev.to === 'awaiting_plan') rows.push({ at: ev.at, kind: 'gate', icon: 'map', text: 'The plan is ready for your review', open: { tab: 'plan' } });
        else if (ev.to === 'review') rows.push({ at: ev.at, kind: 'gate', icon: 'eye', text: 'The changes are ready for your review', open: { tab: 'changes' } });
        else if (ev.to === 'question') rows.push({ at: ev.at, kind: 'gate', icon: 'message', text: 'The agent asked you a question' });
        else if (ev.to === 'stopped') rows.push({ at: ev.at, kind: 'sys', icon: 'stop', text: 'Stopped' });
        else if (ev.to === 'failed') rows.push({ at: ev.at, kind: 'err', icon: 'alert', ok: false, text: 'Stopped with an error', sub: ev.error });
        break;
      case 'recover.interrupted':
        rows.push({ at: ev.at, kind: 'err', icon: 'alert', ok: false, text: 'Interrupted: ORBIX closed while this was working', sub: ev.pending?.filter((p) => p.sideEffect).length ? `Outcome unknown: ${ev.pending.filter((p) => p.sideEffect).map((p) => `${p.name} ${p.detail}`).join('; ')}` : '' });
        for (const row of calls.values()) if (row.pending) (row.pending = false), (row.unknown = true);
        break;
      case 'recover.acknowledged':
        rows.push({ at: ev.at, kind: 'you', icon: 'refresh', text: 'You resumed the run', sub: ev.calls?.length ? 'The agent was told to check the state first' : '' });
        break;
      case 'apply.done':
        rows.push({ at: ev.at, kind: 'you', icon: 'check', text: `You applied the changes to ${ev.branch}`, sub: `${ev.files} file${ev.files === 1 ? '' : 's'} · ${String(ev.hash || '').slice(0, 8)}` });
        break;
      case 'apply.partial': {
        const parts = Object.keys(ev.hunks || {}).length ? ` (${Object.entries(ev.hunks).map(([f, l]) => `${f}: ${plural(l.length, 'hunk')}`).join(', ')})` : '';
        rows.push({ at: ev.at, kind: 'you', icon: 'check', text: `You applied ${plural(ev.files?.length || 0, 'file')} to ${ev.branch}`, sub: `${(ev.files || []).join(', ')}${parts} · ${String(ev.hash || '').slice(0, 8)}${ev.remaining?.length ? ` · ${plural(ev.remaining.length, 'file')} still to review` : ''}` });
        break;
      }
      case 'apply.conflict':
        rows.push({ at: ev.at, kind: 'err', icon: 'alert', ok: false, text: 'Apply stopped: conflict, nothing was changed', sub: (ev.files || []).join(', ') });
        break;
      case 'apply.refused':
        rows.push({ at: ev.at, kind: 'err', icon: 'alert', ok: false, text: 'Apply refused, nothing was changed', sub: ev.reason });
        break;
      case 'discard.done':
        rows.push({ at: ev.at, kind: 'you', icon: 'trash', text: 'You discarded the run', sub: ev.branch });
        break;
      default:
    }
  }
  return rows;
}

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

class RunDetail {
  constructor(id) {
    this.id = id;
    this.run = runs.get(id) || null;
    this.events = [];
    this.tab = '';
    this.rev = {}; // artifact kind -> revision on screen (absent = latest)
    this.file = '';
    this.diff = null;
    this.root = h('div', { class: 'run-page' });
    this.refetch = debounce(() => this.loadEvents(), 120);
    this.load();
  }

  async load() {
    replace(this.root, skeleton(6));
    try {
      const j = await api.get(`/api/run?id=${this.id}`);
      // An update that arrived while this was loading is newer than the answer.
      this.run = this.run && this.run.updatedAt > j.run.updatedAt ? this.run : j.run;
      runs.set(this.run.id, this.run);
      this.events = j.events;
      this.pickTab();
      this.draw();
    } catch (e) {
      replace(this.root, errorState(e.message, { retry: () => this.load(), action: btn('Back to runs', () => openHub('runs')) }));
    }
  }

  async loadEvents() {
    const after = this.events.at(-1)?.seq || 0;
    try {
      const j = await api.get(`/api/run?id=${this.id}&after=${after}`);
      if (detail !== this) return;
      for (const ev of j.events) if (ev.seq > (this.events.at(-1)?.seq || 0)) this.events.push(ev);
      this.drawTimeline();
    } catch {}
  }

  /** The document that matters most right now. */
  pickTab(force) {
    const r = this.run;
    const want = r.status === 'awaiting_plan' || r.phase === 'plan' ? 'plan' : r.status === 'review' || FINAL.has(r.status) ? (r.artifacts?.walkthrough ? 'walkthrough' : 'changes') : this.tab || 'plan';
    if (force || !this.tab) this.tab = r.artifacts?.[want] || want === 'changes' ? want : r.artifacts?.plan ? 'plan' : 'changes';
  }

  update(run) {
    const before = this.run;
    this.run = run;
    if (!this.headEl) return; // still loading: the page is drawn from this newer state when the load finishes
    const moved = before?.status !== run.status;
    if (moved && ['awaiting_plan', 'review'].includes(run.status)) this.pickTab(true);
    this.refetch();
    this.drawHead();
    this.drawDecision();
    // Redraw the document when its revision changed, or the changes when the agent stopped working.
    const revOf = (r, k) => r?.artifacts?.[k]?.rev;
    // A new revision replaces an older one you were reading: the newest is what needs your eyes.
    for (const k of Object.keys(run.artifacts || {})) if (revOf(before, k) !== revOf(run, k)) delete this.rev[k];
    const parts = (r) => r?.accepted?.parts?.length || 0;
    const notes = before?.comments?.length !== run.comments?.length || before?.comments?.filter((c) => c.sent).length !== run.comments?.filter((c) => c.sent).length;
    if (this.tab === 'changes' ? moved || parts(before) !== parts(run) : revOf(before, this.tab) !== revOf(run, this.tab) || moved || notes) this.drawBody();
    else {
      this.drawTabs();
      if (this.tab === 'changes' && notes) this.drawChangeNotes();
    }
  }

  draw() {
    this.headEl = h('header', { class: 'run-head' });
    this.decEl = h('div', { class: 'run-decision' });
    this.stepsEl = h('ol', { class: 'rsteps', 'aria-label': 'Timeline' });
    this.tabsEl = h('div', { class: 'run-tabs', role: 'tablist' });
    this.bodyEl = h('div', { class: 'run-body', role: 'tabpanel', tabindex: '0' });
    this.fbEl = h('div', { class: 'run-feedback' });
    replace(this.root,
      this.headEl,
      this.decEl,
      h('div', { class: 'run-cols' },
        h('aside', { class: 'run-side', 'aria-label': 'What happened' }, h('h2', null, 'Timeline'), this.stepsEl),
        h('section', { class: 'run-main' }, this.tabsEl, this.bodyEl, this.fbEl)));
    this.drawHead();
    this.drawDecision();
    this.drawTimeline();
    this.drawBody();
  }

  drawHead() {
    const r = this.run;
    const more = (e) => popMenu(e.currentTarget, [
      r.status === 'discarded' ? null : { label: 'Open the conversation', run: () => openConversation(r) },
      r.worktree?.path ? { label: 'Copy the worktree path', run: () => navigator.clipboard?.writeText(r.worktree.path).then(() => toast('Copied', 'ok', 1500)) } : null,
      !FINAL.has(r.status) && !WORKING.has(r.status) && r.phase === 'execute' ? { label: 'Keep the branch and finish the run', run: () => post('/api/run/keep', { id: r.id }).catch(() => {}) } : null,
      FINAL.has(r.status) ? { label: 'Remove from the list', danger: true, run: async () => (await confirmDialog('Remove this run from the list?', 'Its record, timeline and documents are deleted. The conversation stays in the project.', { ok: 'Remove', danger: true })) && post('/api/run/delete', { id: r.id }).catch(() => {}) } : null,
    ].filter(Boolean), { align: 'end' });
    replace(this.headEl,
      h('button', { class: 'run-back', type: 'button', onclick: () => openHub('runs'), title: 'All runs' }, icon('chevron-left', 15), 'Runs'),
      h('div', { class: 'run-head-main' },
        h('h1', { class: 'ell', title: r.title }, r.title),
        h('div', { class: 'run-meta' }, icon('folder', 12), h('span', { title: r.project }, projName(r)), r.worktree?.branch ? [icon('branch', 12), h('span', null, r.worktree.branch)] : null, r.model ? [icon('cpu', 12), h('span', null, r.model)] : null, h('span', { class: 'num' }, `started ${timeAgo(r.createdAt)}`))),
      pill(r.status),
      iconBtn('more', 'More', more));
  }

  drawDecision() {
    const r = this.run;
    const st = STATUS[r.status] || {};
    const asks = (r.asks || []).map((a) => askCard(r, a));
    const acts = decisionButtons(r).filter(Boolean);
    const part = !FINAL.has(r.status) && r.accepted?.parts?.length ? ` Part of the changes is in ${r.worktree?.baseBranch || 'your branch'} already (${plural(new Set(r.accepted.parts.flatMap((x) => x.files)).size, 'file')}); the rest is still here.` : '';
    const why = part && r.status === 'review' ? (st.hint || '') + part : r.status === 'failed' && r.error ? r.error : r.status === 'interrupted' && r.interrupted?.pending?.some((p) => p.sideEffect) ? `In flight when it stopped, outcome unknown: ${r.interrupted.pending.filter((p) => p.sideEffect).map((p) => `${p.name} ${p.detail}`).join('; ')}` : st.hint || '';
    this.decEl.className = `run-decision ${asks.length ? 'you' : st.cls || ''}`;
    replace(this.decEl,
      asks,
      asks.length ? null : h('div', { class: 'run-decision-row' },
        WORKING.has(r.status) ? spinner(14) : null,
        h('span', { class: 'run-decision-text prewrap' }, why),
        r.status === 'applied' && r.applied ? h('code', null, String(r.applied.hash || '').slice(0, 8)) : null,
        h('span', { class: 'grow' }),
        acts));
  }

  drawTimeline() {
    const rows = timelineRows(this.events);
    const stick = this.stepsEl.parentNode && this.stepsEl.parentNode.scrollTop + this.stepsEl.parentNode.clientHeight >= this.stepsEl.parentNode.scrollHeight - 40;
    replace(this.stepsEl, rows.map((row) => {
      const state = row.pending ? 'pending' : row.unknown ? 'unknown' : row.ok === false ? 'bad' : '';
      const body = [
        h('span', { class: 'rstep-ic' }, row.pending ? spinner(12) : icon(row.icon, 13)),
        h('span', { class: 'rstep-main' },
          h('span', { class: 'rstep-text' }, row.text, row.detail ? [' ', h('code', { class: 'rstep-detail' }, row.detail)] : null,
            row.exit != null && row.exit !== 0 ? h('span', { class: 'rstep-tag bad' }, `exit ${row.exit}`) : null,
            row.answer ? h('span', { class: `rstep-tag ${row.ok ? '' : 'bad'}` }, row.answer) : null,
            row.unknown ? h('span', { class: 'rstep-tag bad' }, 'outcome unknown') : null),
          row.sub ? h('span', { class: 'rstep-sub' }, row.sub) : null),
        h('time', { class: 'rstep-time num', title: new Date(row.at).toLocaleString() }, clock(row.at)),
      ];
      return h('li', { class: `rstep-row ${row.kind} ${state}` }, row.open ? h('button', { class: 'rstep-btn', type: 'button', title: 'Open what this step produced', onclick: () => this.open(row.open) }, body) : h('div', { class: 'rstep-btn' }, body));
    }));
    if (stick && this.stepsEl.parentNode) this.stepsEl.parentNode.scrollTop = this.stepsEl.parentNode.scrollHeight;
  }

  open({ tab, rev, file }) {
    this.tab = tab;
    if (rev && rev < (this.run.artifacts?.[tab]?.rev || 0)) this.rev[tab] = rev; // an older revision stays pinned until you leave it
    else delete this.rev[tab];
    if (file) this.file = file;
    this.drawBody();
    this.bodyEl.focus({ preventScroll: true });
  }

  drawTabs() {
    const r = this.run;
    const tabs = [['plan', 'Plan'], ['tasks', 'Tasks'], ['changes', 'Changes'], ['tests', 'Test log'], ['walkthrough', 'Walkthrough'], ['note', 'Note']].filter(([k]) => k === 'changes' || k === 'plan' || r.artifacts?.[k]);
    const notes = (k) => (r.comments || []).filter((c) => !c.sent && (k === 'changes' ? !ART[c.target] : c.target === k)).length;
    replace(this.tabsEl, tabs.map(([k, label]) => h('button', { class: 'run-tab' + (this.tab === k ? ' cur' : ''), type: 'button', role: 'tab', 'aria-selected': String(this.tab === k), onclick: () => ((this.tab = k), this.drawBody()) },
      label,
      k !== 'changes' && r.artifacts?.[k]?.rev > 1 ? h('span', { class: 'run-tab-rev num', title: `${r.artifacts[k].rev} revisions` }, `r${r.artifacts[k].rev}`) : null,
      k === 'tests' && r.checks ? h('span', { class: `dot ${r.checks.status === 'passed' ? 'open' : 'dead'}` }) : null,
      notes(k) ? h('span', { class: 'run-tab-n num', title: 'Comments not sent yet' }, notes(k)) : null)));
  }

  async drawBody() {
    this.drawTabs();
    this.drawFeedback();
    const r = this.run;
    const tab = this.tab;
    if (tab === 'changes') return this.drawChanges();
    const meta = r.artifacts?.[tab];
    if (!meta) {
      const waiting = tab === 'plan' && r.status === 'planning';
      return replace(this.bodyEl, h('div', { class: 'empty' }, waiting ? spinner(18) : icon('file', 22), h('span', null, waiting ? 'The agent is reading the code. The plan appears here when it is written.' : tab === 'plan' ? (r.mode === 'direct' ? 'This run started without a plan.' : 'No plan was saved yet.') : 'Nothing here yet.')));
    }
    const rev = Math.min(this.rev[tab] || meta.rev, meta.rev);
    replace(this.bodyEl, skeleton(5));
    try {
      const j = await api.get(`/api/run/artifact?id=${r.id}&kind=${tab}&rev=${rev}`);
      if (this.tab !== tab || detail !== this) return;
      const a = j.artifact;
      const doc = renderMarkdown(a.content);
      doc.classList.add('art-doc');
      const revs = h('select', { class: 'art-rev', 'aria-label': 'Revision', onchange: (e) => ((this.rev[tab] = Number(e.target.value)), this.drawBody()) }, Array.from({ length: a.latest }, (_, i) => a.latest - i).map((n) => h('option', { value: String(n), selected: n === a.rev ? true : null }, n === a.latest ? `Revision ${n} (latest)` : `Revision ${n}`)));
      const canComment = !FINAL.has(r.status) && tab !== 'tests';
      const bar = h('div', { class: 'art-bar' },
        h('span', { class: 'art-title ell' }, a.title),
        h('span', { class: 'muted small num' }, `${a.author === 'orbix' ? 'ORBIX' : 'Agent'} · ${timeAgo(a.at)}`),
        h('span', { class: 'grow' }),
        a.latest > 1 ? revs : null,
        canComment ? btn('Comment', () => this.commentOn(tab, a.rev, selectionIn(doc)), 'sm') : null);
      replace(this.bodyEl, bar, a.rev < a.latest ? h('p', { class: 'art-old' }, icon('info', 13), `You are reading revision ${a.rev}. `, h('button', { class: 'link', type: 'button', onclick: () => (delete this.rev[tab], this.drawBody()) }, `Show revision ${a.latest}`)) : null, doc, this.commentList((c) => c.target === tab));
    } catch (e) {
      if (this.tab === tab) replace(this.bodyEl, errorState(e.message, { retry: () => this.drawBody() }));
    }
  }

  async drawChanges() {
    const r = this.run;
    if (r.phase === 'plan' && !FINAL.has(r.status)) return replace(this.bodyEl, h('div', { class: 'empty' }, icon('branch', 22), h('span', null, 'Nothing has been changed yet. The agent starts after you approve the plan.')));
    if (!this.diff) replace(this.bodyEl, skeleton(5));
    try {
      const seq = (this.drawSeq = (this.drawSeq || 0) + 1); // a later draw (another file clicked) wins over a slower one
      const d = await api.get(`/api/run/diff?id=${r.id}`);
      if (this.tab !== 'changes' || detail !== this || seq !== this.drawSeq) return;
      this.diff = d;
      if (d.gone) return replace(this.bodyEl, h('div', { class: 'empty' }, icon('trash', 22), h('span', null, 'This run was discarded, so its changes are gone.')));
      const appliedParts = !FINAL.has(r.status) && r.accepted?.parts?.length;
      if (!d.files.length) return replace(this.bodyEl, h('div', { class: 'empty' }, icon('branch', 22), h('span', null, WORKING.has(r.status) ? 'No file has been changed yet.' : r.status === 'applied' || appliedParts ? 'The changes were applied to your project.' : 'This run changed no files.')));
      if (!d.files.some((f) => f.path === this.file)) this.file = d.files[0].path;
      const open = !FINAL.has(r.status);
      const p = pickOf(r.id);
      if (p.tree !== d.tree) (p.hunksOff.clear(), p.hunkCount.clear(), (p.tree = d.tree)); // the files moved: hunk numbers may have too
      const add = d.files.reduce((n, f) => n + (f.add || 0), 0);
      const del = d.files.reduce((n, f) => n + (f.del || 0), 0);
      const list = h('ul', { class: 'chg-files', role: 'listbox', 'aria-label': 'Changed files' }, d.files.map((f) => h('li', { class: 'chg-li' },
        open ? h('input', { type: 'checkbox', class: 'chg-pick', title: 'Include this file when you apply', 'aria-label': `Apply ${f.path}`, checked: p.off.has(f.path) ? null : true, onchange: (e) => (e.target.checked ? p.off.delete(f.path) : p.off.add(f.path)) }) : null,
        h('button', { class: 'chg-file' + (f.path === this.file ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(f.path === this.file), title: f.path, onclick: () => ((this.file = f.path), this.drawChanges()) },
          h('span', { class: `chg-st ${f.status}` }, f.untracked ? 'A' : f.status), h('span', { class: 'ell grow' }, f.path), statChips(f)))));
      const view = h('div', { class: 'chg-diff' }, skeleton(4));
      const f = d.files.find((x) => x.path === this.file);
      this.notesEl = h('div');
      replace(this.bodyEl,
        h('div', { class: 'art-bar' }, h('span', { class: 'art-title' }, `${d.files.length} changed file${d.files.length === 1 ? '' : 's'}${appliedParts ? ' still to apply' : ''}`), statChips({ add, del }), appliedParts ? h('span', { class: 'muted small' }, `${plural(new Set(r.accepted.parts.flatMap((x) => x.files)).size, 'file')} applied already`) : null, d.main?.dirty ? h('span', { class: 'muted small' }, 'Your project folder has uncommitted work; it is kept when you apply.') : null, h('span', { class: 'grow' }), open ? btn('Comment on this file', () => this.commentOn(this.file, 0, ''), 'sm') : null),
        open ? h('p', { class: 'muted small chg-help' }, 'Untick a file or a hunk to leave it out when you apply. Click a line number to comment on that line; Shift+click a second one for a range.') : null,
        h('div', { class: 'chg' }, list, view),
        this.notesEl);
      this.drawChangeNotes();
      const fd = await api.get(`/api/run/diff/file?id=${r.id}&file=${encodeURIComponent(f.path)}&tree=${encodeURIComponent(d.tree || '')}`);
      if (this.tab !== 'changes' || this.file !== f.path || seq !== this.drawSeq) return;
      if (!fd.diff.text) return replace(view, h('div', { class: 'empty' }, 'This file cannot be shown as text.'));
      this.diffEl = renderUnifiedDiff(fd.diff.text, f.path);
      replace(view, this.diffEl);
      if (open) this.wireDiff(this.diffEl, f.path, fd.diff.text);
      this.markLines();
    } catch (e) {
      if (this.tab === 'changes') replace(this.bodyEl, errorState(e.message, { retry: () => this.drawChanges() }));
    }
  }

  /** The comments under the changes, redrawn alone so the diff keeps its scroll position. */
  drawChangeNotes() {
    if (this.notesEl) replace(this.notesEl, this.commentList((c) => !ART[c.target]));
    this.markLines();
  }

  /** Hunk boxes (which parts of the file to apply) and line numbers that start a comment on their line. */
  wireDiff(view, path, text) {
    const p = pickOf(this.run.id);
    const hunks = [...view.querySelectorAll('.dl.hunk')];
    const whole = /^(new file mode|deleted file mode|Binary files |GIT binary patch)/m.test(text);
    if (hunks.length > 1 && !whole) {
      p.hunkCount.set(path, hunks.length);
      const off = p.hunksOff.get(path) || new Set();
      const shade = () => {
        let i = -1;
        for (const row of view.children) {
          if (row.classList.contains('hunk')) i++;
          if (i >= 0) row.classList.toggle('pick-off', off.has(i));
        }
      };
      hunks.forEach((row, i) => {
        const cb = h('input', { type: 'checkbox', class: 'hunk-pick', title: 'Include this hunk when you apply', 'aria-label': `Apply hunk ${i + 1} of ${hunks.length}`, checked: off.has(i) ? null : true, onchange: (e) => {
          e.target.checked ? off.delete(i) : off.add(i);
          if (off.size) p.hunksOff.set(path, off);
          else p.hunksOff.delete(path);
          // No hunk left: the file is left out; one ticked again: it is back in.
          if (off.size === hunks.length) p.off.add(path);
          else p.off.delete(path);
          const box = this.bodyEl.querySelector(`.chg-li .chg-pick[aria-label="${CSS.escape(`Apply ${path}`)}"]`);
          if (box) box.checked = !p.off.has(path);
          shade();
        } });
        row.firstChild.append(cb);
      });
      shade();
    }
    const lines = [...view.querySelectorAll('.dl.add, .dl.del, .dl.eq')];
    let anchor = -1;
    view.addEventListener('click', (e) => {
      const ln = e.target.closest('.ln');
      const row = ln?.closest('.dl');
      const at = row ? lines.indexOf(row) : -1;
      if (at < 0) return;
      const from = e.shiftKey && anchor >= 0 ? Math.min(anchor, at) : at;
      const to = e.shiftKey && anchor >= 0 ? Math.max(anchor, at) : at;
      anchor = at;
      const rows = lines.slice(from, to + 1).map((x) => {
        const [a, b] = x.querySelectorAll('.ln');
        return { a: +a.textContent || 0, b: +b.textContent || 0, cls: x.classList.contains('add') ? 'add' : x.classList.contains('del') ? 'del' : 'eq', text: x.querySelector('.tx')?.textContent || '' };
      });
      const news = rows.filter((x) => x.b).map((x) => x.b);
      const side = news.length ? 'new' : 'old';
      const nums = news.length ? news : rows.map((x) => x.a);
      const mixed = new Set(rows.map((x) => x.cls)).size > 1;
      const quote = rows.map((x) => (mixed ? (x.cls === 'add' ? '+' : x.cls === 'del' ? '-' : ' ') : '') + x.text).join('\n');
      this.commentOn(path, 0, quote, { line: Math.min(...nums), lineEnd: Math.max(...nums), side });
    });
  }

  /** Lines that have a comment are marked in the diff. */
  markLines() {
    const view = this.diffEl;
    if (!view?.isConnected) return;
    const notes = (this.run.comments || []).filter((c) => c.target === this.file && c.line);
    for (const row of view.querySelectorAll('.dl.add, .dl.del, .dl.eq')) {
      const [a, b] = row.querySelectorAll('.ln');
      const na = +a.textContent || 0;
      const nb = +b.textContent || 0;
      row.classList.toggle('cmt-line', notes.some((c) => {
        const n = c.side === 'old' ? (nb ? 0 : na) : nb; // a comment on removed lines counts in the original file
        return n && n >= c.line && n <= c.lineEnd;
      }));
    }
  }

  commentList(filter) {
    const list = (this.run.comments || []).filter(filter);
    if (!list.length) return null;
    return h('section', { class: 'cmts', 'aria-label': 'Comments' }, h('h3', null, 'Comments'), list.map((c) => h('div', { class: 'cmt' + (c.sent ? ' sent' : '') },
      h('div', { class: 'cmt-top' }, h('span', { class: 'cmt-on ell' }, ART[c.target] ? `${ART[c.target]}${c.rev ? `, revision ${c.rev}` : ''}` : where(c)), h('span', { class: 'muted small' }, c.sent ? 'sent to the agent' : 'not sent yet'), h('span', { class: 'grow' }),
        c.sent ? null : iconBtn('trash', 'Delete this comment', () => post('/api/run/comment/remove', { id: this.run.id, comment: c.id }).catch(() => {}), 'sm')),
      c.quote ? h('blockquote', { class: 'cmt-quote' + (c.line ? ' code' : '') }, c.quote) : null,
      h('p', { class: 'prewrap' }, c.text))));
  }

  commentOn(target, rev, quote, lines = null) {
    const text = h('textarea', { rows: '4', placeholder: 'What should change here?', 'aria-label': 'Comment' });
    const save = async () => {
      if (!text.value.trim()) return text.focus();
      m.close();
      await post('/api/run/comment', { id: this.run.id, target, rev, quote, text: text.value, ...(lines || {}) }).catch(() => {});
    };
    text.addEventListener('keydown', (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && (e.preventDefault(), save()));
    const m = modal({
      title: ART[target] ? `Comment on the ${ART[target].toLowerCase()}` : `Comment on ${lines ? where({ target, ...lines }) : target}`,
      size: 'md',
      body: h('div', { class: 'cmt-new' }, lines?.side === 'old' ? h('p', { class: 'muted small' }, 'Removed lines, numbered as in the original file.') : null, quote ? h('blockquote', { class: 'cmt-quote' + (lines ? ' code' : '') }, quote) : ART[target] ? h('p', { class: 'muted small' }, 'Tip: select some text in the document first to comment on that passage.') : null, text, h('p', { class: 'muted small' }, 'Comments are held until you send feedback or approve the plan, then go to the agent together.')),
      actions: [btn('Cancel', () => m.close()), btn('Add comment', save, 'primary')],
      initialFocus: text,
    });
  }

  drawFeedback() {
    const r = this.run;
    if (FINAL.has(r.status)) return replace(this.fbEl);
    const pending = (r.comments || []).filter((c) => !c.sent).length;
    const keep = this.fbEl.querySelector('textarea')?.value || '';
    const box = h('textarea', { rows: '2', placeholder: WORKING.has(r.status) ? 'Steer the agent while it works…' : r.phase === 'plan' ? 'Ask for changes to the plan, or answer the agent…' : 'Ask for changes…', 'aria-label': 'Feedback to the agent' });
    box.value = keep;
    const send = async () => {
      if (!box.value.trim() && !pending) return box.focus();
      sendBtn.disabled = true;
      try {
        await api.post('/api/run/feedback', { id: r.id, text: box.value });
        box.value = '';
      } catch (e) {
        toast(e.message, 'error', 9000);
      } finally {
        sendBtn.disabled = false;
      }
    };
    box.addEventListener('keydown', (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && (e.preventDefault(), send()));
    const sendBtn = btn(pending ? `Send with ${pending} comment${pending === 1 ? '' : 's'}` : 'Send feedback', send, 'sm');
    replace(this.fbEl, box, h('div', { class: 'run-feedback-row' }, h('span', { class: 'muted small' }, 'Ctrl+Enter to send'), h('span', { class: 'grow' }), sendBtn));
  }
}

/** The text selected inside `root`, or '' when the selection is elsewhere. */
function selectionIn(root) {
  const s = window.getSelection?.();
  if (!s || s.isCollapsed || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return '';
  return s.toString().trim().slice(0, 600);
}

// ---- Drawing -------------------------------------------------------------------------------------------------------

const drawSoon = debounce(() => hub && hub.view !== 'run' && draw(), 80);

export function draw() {
  const root = el();
  if (!root || !hub) return;
  if (hub.view === 'run') {
    if (!detail || detail.id !== hub.id) detail = new RunDetail(hub.id);
    if (root.firstChild !== detail.root) replace(root, detail.root);
    return;
  }
  detail = null;
  // Keep what is being typed in the task box across a redraw.
  const typed = root.querySelector('.run-new textarea');
  const keep = typed ? { v: typed.value, f: document.activeElement === typed, s: typed.selectionStart } : null;
  if (hub.view === 'review') drawReview();
  else drawRuns();
  const box = root.querySelector('.run-new textarea');
  if (keep && box) {
    box.value = keep.v;
    if (keep.f) (box.focus({ preventScroll: true }), box.setSelectionRange(keep.s, keep.s));
  }
}

on('hub', draw);
// A conversation asked for (or got) an approval: the queue and its count follow.
on('tab:dialog', () => {
  emit('runs');
  drawSoon();
});
on('env', () => hub && hub.view === 'runs' && drawSoon());
