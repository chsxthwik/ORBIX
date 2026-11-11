// Sessions on their own branch: the "Separate branch" choice when a session starts, what the board in the sidebar
// says about each one, and the Review view of the side panel (changed files, then merge, keep or discard).
import { h, icon, iconBtn, skeleton, toast, errorState } from './dom.js';
import { api } from './api.js';
import { emit, on, closeTab } from './store.js';
import { renderUnifiedDiff, statChips } from './tools.js';
import { confirmDialog, isApproval } from './dialogs.js';

// ---- Starting a session on its own branch -----------------------------------------------------------------------

const repoOf = new Map(); // project path -> true | false | Promise (is it a git repository with a commit?)

/** Whether `project` is a git repository; asks once per folder and calls `then` when the answer arrives. */
function isRepo(project, then) {
  const v = repoOf.get(project);
  if (typeof v === 'boolean') return v;
  if (!v)
    repoOf.set(
      project,
      api
        .get(`/api/git/status?ws=${encodeURIComponent(project)}`)
        .then((r) => !!r.git?.repo)
        .catch(() => false)
        .then((ok) => {
          repoOf.set(project, ok);
          then?.();
        }),
    );
  return false;
}

/**
 * The "Separate branch" toggle of the new-session box: shown for git projects only. `state.branch` is the choice.
 * Returns null when the project is not a git repository (or the answer is not in yet; `redraw` runs when it is).
 */
export function branchToggle(state, project, redraw) {
  if (!project || !isRepo(project, redraw)) {
    state.branch = false;
    return null;
  }
  const on = !!state.branch;
  return h(
    'button',
    {
      class: 'cbtn branch-pick' + (on ? ' on' : ''),
      type: 'button',
      'aria-pressed': String(on),
      title: on ? 'The session works on a new branch in its own folder. You review and merge it when it is done. Click to work in the project folder instead.' : 'Work on a new branch in a separate folder, so several sessions can run at once without touching each other.',
      onclick: () => {
        state.branch = !on;
        redraw();
      },
    },
    icon('branch', 14),
    h('span', null, on ? 'Separate branch' : 'Project folder'),
  );
}

// ---- The board in the sidebar -----------------------------------------------------------------------------------

/** 'needs you' | 'working' | 'done' | 'merged' | 'kept' for a tab, as the sidebar board shows it. */
export function boardState(t) {
  if (t.dialogs.some(isApproval)) return 'needs you';
  if (t.streaming) return 'working';
  const st = t.worktree?.state;
  if (st === 'merged' || st === 'kept') return st;
  return 'done';
}

/** Sessions the board lists: working or waiting, and every session on its own branch until it is closed. */
export const onBoard = (t) => !t.dead && (t.streaming || t.dialogs.some(isApproval) || !!t.worktree);

// ---- Review view ------------------------------------------------------------------------------------------------

const R = new Map(); // tab id -> { data, err, loading, diff, busy, conflict, note }
const rs = (t) => R.get(t.id) || (R.set(t.id, {}), R.get(t.id));

// The panel redraws itself from these events; the review keeps what it loaded per session.
on('tab:worktree', (t) => emit('tab:panel', t, 'review'));

/** Load what the session changed on its branch. */
export async function loadReview(t, redraw) {
  const r = rs(t);
  r.loading = true;
  if (!r.data) redraw();
  try {
    r.data = await api.get(`/api/branch?proc=${encodeURIComponent(t.id)}`);
    r.err = null;
  } catch (e) {
    r.err = e.message;
  }
  r.loading = false;
  redraw();
}

/** Number of files the branch changed (for the tab badge), when known. */
export const reviewCount = (t) => R.get(t?.id)?.data?.files?.length || 0;

const letter = (f) => (f.untracked ? 'U' : f.status === 'D' ? 'D' : f.status === 'A' ? 'A' : 'M');

export function drawReview(t, body, { redraw, viewFile }) {
  const r = rs(t);
  const wt = t.worktree;
  if (!wt) return body.append(h('div', { class: 'empty' }, 'This session works in the project folder. Start a session with "Separate branch" to review its work here before it lands.'));
  if (r.diff) return drawFileDiff(t, body, r, redraw, viewFile);
  if (!r.data && !r.loading && !r.err) loadReview(t, redraw);

  const head = h('div', { class: 'p-bar' }, icon('branch', 14), h('span', { class: 'grow ell', title: `${wt.branch}, started from ${wt.baseBranch || 'a detached HEAD'} at ${wt.base.slice(0, 7)}` }, h('bdi', null, wt.branch), h('span', { class: 'rv-base' }, ` from ${wt.baseBranch || wt.base.slice(0, 7)}`)), iconBtn('refresh', 'Refresh', () => loadReview(t, redraw), 'sm'));
  body.append(head);
  if (r.loading && !r.data) return body.append(skeleton(6, 'pad'));
  if (r.err) return body.append(errorState(r.err, { title: 'Couldn’t read this branch.', retry: () => loadReview(t, redraw) }));
  if (!r.data) return;

  const d = r.data;
  const list = h('div', { class: 'p-scroll' });
  const sum = summary(t, d);
  if (sum) list.append(sum);
  if (r.conflict) list.append(conflictNote(wt, r.conflict));
  if (!d.files.length) list.append(h('div', { class: 'empty' }, wt.state === 'merged' ? 'Everything on this branch is merged.' : 'No changes on this branch yet.'));
  else
    list.append(
      h('div', { class: 'list-h gh' }, h('span', { class: 'grow' }, `Changed files · ${d.files.length}`)),
      ...d.files.map((f) =>
        h('div', { class: 'gitem' }, h('button', { class: 'gfile', type: 'button', title: f.path, onclick: () => openFileDiff(t, f, redraw) }, h('span', { class: `gs ${letter(f)}` }, letter(f)), h('span', { class: 'ell grow' }, h('bdi', null, f.path)), statChips({ add: f.add || 0, del: f.del || 0 }, 'rv-stat num'))),
      ),
    );
  body.append(list, actions(t, d, r, redraw));
}

function summary(t, d) {
  const wt = t.worktree;
  const lines = [];
  if (wt.state === 'merged') lines.push(`Merged into ${wt.baseBranch}${wt.hash ? ` as ${wt.hash.slice(0, 7)}` : ''}.${d.pending || d.ahead ? ' The agent changed more since then.' : ''}`);
  else if (wt.state === 'kept') lines.push('Kept. The branch and its folder stay as they are; you can merge or discard it later.');
  if (t.streaming) lines.push('The agent is still working. Merge and discard wait until it is done.');
  const parts = [];
  if (d.commits) parts.push(`${d.commits} commit${d.commits === 1 ? '' : 's'}`);
  if (d.pending) parts.push('edits not committed yet (they are committed on the branch when you merge)');
  if (parts.length) lines.push(parts.join(', ').replace(/^./, (c) => c.toUpperCase()) + '.');
  if (d.main?.dirty && d.files.length) lines.push(`The project folder has uncommitted changes. Commit or stash them before you merge into ${wt.baseBranch}.`);
  else if (d.main && wt.baseBranch && d.main.branch !== wt.baseBranch) lines.push(`The project folder is on ${d.main.branch || 'a detached HEAD'} now. Switch it back to ${wt.baseBranch} to merge.`);
  return lines.length ? h('div', { class: 'rv-note' }, lines.map((l) => h('p', null, l))) : null;
}

function conflictNote(wt, files) {
  return h('div', { class: 'rv-note rv-conflict', role: 'alert' },
    h('p', null, `Not merged: ${files.length === 1 ? 'this file was' : 'these files were'} changed both here and in ${wt.baseBranch} since the session started.`),
    h('ul', null, files.slice(0, 8).map((f) => h('li', null, h('bdi', null, f)))),
    h('p', null, `Nothing was changed: ${wt.baseBranch} and this branch are as they were. Ask the agent to merge ${wt.baseBranch} into its branch and resolve the conflict, then merge again.`));
}

function actions(t, d, r, redraw) {
  const wt = t.worktree;
  const busy = !!r.busy || t.streaming || t.dead;
  const merged = wt.state === 'merged';
  const news = d.pending || d.ahead == null || d.ahead > 0; // something not in the base branch yet
  const canMerge = d.files.length > 0 && news && !!wt.baseBranch && !d.main?.dirty && (!d.main || d.main.branch === wt.baseBranch);
  const mergeBtn = h('button', { class: 'btn primary sm', type: 'button', disabled: busy || !canMerge, title: !wt.baseBranch ? 'The session started on a detached HEAD: merge it with git yourself.' : !news ? `Everything on this branch is in ${wt.baseBranch}.` : '' }, r.busy === 'merge' ? 'Merging…' : `Merge into ${wt.baseBranch || 'base'}`);
  const keepBtn = h('button', { class: 'btn sm', type: 'button', disabled: busy || merged || wt.state === 'kept' }, 'Keep branch');
  const dropBtn = h('button', { class: 'btn sm danger', type: 'button', disabled: busy }, r.busy === 'discard' ? 'Removing…' : merged ? 'Remove branch' : 'Discard');
  mergeBtn.addEventListener('click', () => merge(t, d, r, redraw));
  keepBtn.addEventListener('click', () => keep(t, r, redraw));
  dropBtn.addEventListener('click', () => discard(t, d, r, redraw));
  return h('div', { class: 'rv-actions' }, mergeBtn, keepBtn, h('span', { class: 'grow' }), dropBtn);
}

async function merge(t, d, r, redraw) {
  const wt = t.worktree;
  const n = d.files.length;
  const ok = await confirmDialog(
    `Merge into ${wt.baseBranch}?`,
    `${n} changed file${n === 1 ? '' : 's'} from ${wt.branch} are merged into ${wt.baseBranch} in the project folder, with a merge commit.${d.pending ? '\n\nEdits the agent has not committed are committed on its branch first.' : ''}\n\nIf the same lines changed in ${wt.baseBranch} meanwhile, nothing is merged and both stay as they are.`,
    { ok: 'Merge' },
  );
  if (!ok) return;
  r.busy = 'merge';
  r.conflict = null;
  redraw();
  try {
    const out = await api.post('/api/branch/merge', { proc: t.id, confirm: true });
    t.worktree = out.worktree || t.worktree;
    if (out.result?.conflict) r.conflict = out.result.files || [];
    else toast(`Merged into ${wt.baseBranch}`, 'ok', 3000);
    emit('tabs');
  } catch (e) {
    toast(e.message, 'error', 8000);
  } finally {
    r.busy = null;
    emit('tab:panel', t, 'git');
    await loadReview(t, redraw);
  }
}

async function keep(t, r, redraw) {
  r.busy = 'keep';
  redraw();
  try {
    const out = await api.post('/api/branch/keep', { proc: t.id });
    t.worktree = out.worktree || t.worktree;
    emit('tabs');
  } catch (e) {
    toast(e.message, 'error', 6000);
  } finally {
    r.busy = null;
    redraw();
  }
}

async function discard(t, d, r, redraw) {
  const wt = t.worktree;
  const merged = wt.state === 'merged';
  const lost = merged ? '' : d.files.length ? `\n\nThe ${d.files.length} changed file${d.files.length === 1 ? '' : 's'} on it are lost. This cannot be undone.` : '';
  const ok = await confirmDialog(
    merged ? 'Remove this branch?' : 'Discard this branch?',
    `The session's folder is removed, ${wt.branch} is deleted and the session closes.${merged ? ` Its work is already in ${wt.baseBranch}.` : ''}${lost}`,
    { ok: merged ? 'Remove' : 'Discard', danger: !merged },
  );
  if (!ok) return;
  r.busy = 'discard';
  redraw();
  try {
    await api.post('/api/branch/discard', { proc: t.id, confirm: true });
    R.delete(t.id);
    toast(merged ? 'Branch removed' : 'Branch discarded', 'ok', 3000);
    closeTab(t.id); // its folder is gone, so the session cannot go on
  } catch (e) {
    r.busy = null;
    toast(e.message, 'error', 8000);
    redraw();
  }
}

async function openFileDiff(t, f, redraw) {
  const r = rs(t);
  r.diff = { file: f, loading: true };
  redraw();
  try {
    const { diff } = await api.get(`/api/branch/diff?proc=${encodeURIComponent(t.id)}&file=${encodeURIComponent(f.path)}${f.untracked ? '&untracked=1' : ''}`);
    if (r.diff?.file === f) r.diff = { file: f, text: diff.text };
  } catch (e) {
    if (r.diff?.file === f) r.diff = { file: f, error: e.message };
  }
  redraw();
}

function drawFileDiff(t, body, r, redraw, viewFile) {
  const d = r.diff;
  body.append(h('div', { class: 'p-bar' }, iconBtn('chevron-left', 'Back to the branch', () => ((r.diff = null), redraw()), 'sm'), h('span', { class: 'grow ell mono', title: d.file.path }, d.file.path), d.file.status === 'D' ? null : iconBtn('eye', 'View file', () => viewFile(t, d.file.path), 'sm')));
  const c = h('div', { class: 'p-scroll' });
  body.append(c);
  if (d.loading) c.append(skeleton(12, 'pad'));
  else if (d.error) c.append(errorState(d.error, { title: 'Couldn’t load this diff.', retry: () => openFileDiff(t, d.file, redraw) }));
  else if (!d.text.trim()) c.append(h('div', { class: 'empty' }, 'No text changes.'));
  else c.append(renderUnifiedDiff(d.text, d.file.path));
}
