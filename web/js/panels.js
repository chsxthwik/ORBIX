// Right-hand panel: Files, Changes (git), Todos, Agents, Console.
import { h, icon, iconBtn, replace, clear, toast, skeleton, baseName, copyText, debounce } from './dom.js';
import { asciiArt } from './ascii.js';
import { api, rpc } from './api.js';
import { S, activeTab, emit, on, savePrefs } from './store.js';
import { codeView, renderUnifiedDiff, todoList, agentRow } from './tools.js';
import { langFor } from './highlight.js';
import { ansiFragment } from './ansi.js';

const P = { tab: 'files', file: null, diff: null, git: null, gitErr: null, msg: '', committing: false, tree: new Map(), open: new Set(), ws: null, busy: false };
let root;
let body;
let tabsEl;

const TABS = [['files', 'Files', 'folder'], ['changes', 'Changes', 'branch'], ['todos', 'Plan', 'list'], ['agents', 'Agents', 'users'], ['console', 'Console', 'terminal']];

export function mountPanel(el) {
  root = el;
  if (TABS.some(([k]) => k === S.ui.rightTab)) P.tab = S.ui.rightTab;
  tabsEl = h('div', { class: 'ptabs', role: 'tablist', 'aria-label': 'Side panel' });
  body = h('div', { class: 'pbody' });
  root.append(tabsEl, body);
  on('active', () => resetFor(activeTab()));
  on('tab:panel', (tab, kind) => {
    if (tab !== activeTab()) return;
    if (kind === 'git') {
      gitSoon();
      P.tree.clear(); // the agent may have created or removed files
      if (P.tab === 'files' && !P.file) draw();
    }
    if ((kind === 'todos' && P.tab === 'todos') || (kind === 'agents' && P.tab === 'agents')) draw();
    drawTabs();
  });
  on('tab:state', (tab) => tab === activeTab() && drawTabs());
  resetFor(activeTab());
}

function resetFor(tab) {
  const ws = tab?.workspace || null;
  if (ws !== P.ws) {
    Object.assign(P, { ws, file: null, diff: null, git: null, gitErr: null, tree: new Map(), open: new Set() });
    emit('git');
  }
  drawTabs();
  draw();
  if (tab) loadGit(P.tab !== 'changes'); // the status bar shows the branch, so load it for every tab
}

/** Git status of the active project, once loaded (for the status bar). */
export const gitState = (ws) => (ws && ws === P.ws ? P.git : null);

export function showTab(name) {
  P.tab = name;
  P.file = null;
  P.diff = null;
  drawTabs();
  draw();
  if (name === 'changes') loadGit();
  savePrefs({ rightTab: name, rightPanel: true });
  emit('panel:open');
  if (name === 'console') setTimeout(() => body.querySelector('.console-in input')?.focus(), 0);
}

function drawTabs() {
  const t = activeTab();
  const nChanges = P.git?.files?.length || 0;
  const nTodo = (t?.todos || []).flatMap((p) => p.tasks || []).filter((x) => x.status !== 'completed' && x.status !== 'abandoned').length;
  const nAg = [...(t?.subagents?.values() || [])].filter((a) => /running|started|pending/.test(a.progress?.status || a.status || '')).length;
  const badge = { changes: nChanges, todos: nTodo, agents: nAg };
  replace(tabsEl, TABS.map(([k, l, ic]) => h('button', { class: 'ptab' + (P.tab === k ? ' cur' : ''), type: 'button', role: 'tab', 'aria-selected': String(P.tab === k), title: l, onclick: () => showTab(k) }, icon(ic, 14), h('span', { class: 'lbl' }, l), badge[k] ? h('span', { class: 'badge num' }, badge[k]) : null)));
}

function draw() {
  const t = activeTab();
  clear(body);
  if (!t) return;
  ({ files: drawFiles, changes: drawChanges, todos: drawTodos, agents: drawAgents, console: drawConsole })[P.tab](t);
}

const emptyState = (kind, text) => h('div', { class: 'empty' }, asciiArt(kind), text);

const joinP = (a, b) => (/^[A-Za-z]:|^\\\\/.test(a) ? a.replace(/[\\/]+$/, '') + '\\' + b.replace(/\//g, '\\') : (a === '/' ? '' : a.replace(/\/+$/, '')) + '/' + b);

async function loadDir(p) {
  if (P.tree.has(p)) return P.tree.get(p);
  const { listing } = await api.get(`/api/fs/list?path=${encodeURIComponent(p)}`);
  P.tree.set(p, listing.entries);
  return listing.entries;
}

function drawFiles(t) {
  if (P.file) return drawViewer(t);
  const list = h('div', { class: 'tree' });
  body.append(h('div', { class: 'p-bar' }, h('span', { class: 'grow ell', title: t.workspace }, baseName(t.workspace)), iconBtn('refresh', 'Refresh', () => { P.tree.clear(); draw(); }, 'sm')), list);
  const render = async (dir, depth, host) => {
    let ents;
    const sk = P.tree.has(dir) ? null : host.appendChild(skeleton(depth ? 2 : 8, 'tree-skel'));
    try {
      ents = await loadDir(dir);
    } catch (e) {
      sk?.remove();
      host.append(h('div', { class: 'empty err-text' }, e.message));
      return;
    } finally {
      sk?.remove();
    }
    for (const e of ents) {
      const open = e.dir && P.open.has(e.path);
      const kids = h('div');
      const rowEl = h('div', { class: 'tree-row', role: 'treeitem', 'aria-expanded': e.dir ? String(!!open) : null, tabindex: '0', style: { paddingLeft: 8 + depth * 14 + 'px' }, title: e.path, onkeydown: (ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), rowEl.click()), onclick: async () => {
        if (e.dir) {
          if (P.open.has(e.path)) P.open.delete(e.path);
          else P.open.add(e.path);
          draw();
        } else viewFile(t, e.path);
      } }, h('span', { class: 'c' }, e.dir ? icon(open ? 'chevron-down' : 'chevron-right', 12) : null), icon(e.dir ? (open ? 'folder-open' : 'folder') : 'file', 14), h('span', { class: 'ell' }, e.name));
      host.append(rowEl, kids);
      if (open) await render(e.path, depth + 1, kids);
    }
    if (!ents.length && depth === 0) host.append(h('div', { class: 'empty' }, 'Empty folder'));
  };
  render(t.workspace, 0, list);
}

export async function viewFile(tab, p) {
  const clean = p.replace(/:(\d+)(-\d+)?$/, '');
  const abs = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(clean) ? clean : joinP(tab.workspace, clean.replace(/^\.\//, ''));
  P.tab = 'files';
  P.file = { path: abs, loading: true };
  savePrefs({ rightPanel: true, rightTab: 'files' });
  emit('panel:open');
  drawTabs();
  draw();
  try {
    const { file } = await api.get(`/api/fs/read?path=${encodeURIComponent(abs)}`);
    P.file = file;
  } catch (e) {
    P.file = { path: abs, error: e.message };
  }
  if (P.tab === 'files') draw();
}

function drawViewer(t) {
  const f = P.file;
  body.append(h('div', { class: 'p-bar' }, iconBtn('chevron-left', 'Back to files', () => { P.file = null; draw(); }, 'sm'), h('span', { class: 'grow ell mono', title: f.path }, baseName(f.path)), iconBtn('at', 'Mention in the message', () => emit('insert', `@${relTo(t.workspace, f.path)} `), 'sm'), iconBtn('copy', 'Copy path', () => copyText(f.path), 'sm'), iconBtn('external', 'Show in Explorer', () => api.post('/api/fs/reveal', { path: f.path }).catch((e) => toast(e.message, 'error')), 'sm')));
  const c = h('div', { class: 'p-scroll' });
  body.append(c);
  if (f.loading) c.append(skeleton(14, 'pad'));
  else if (f.error) c.append(h('div', { class: 'err-text' }, f.error));
  else if (f.image) c.append(f.dataUrl ? h('img', { class: 'p-img', src: f.dataUrl, alt: baseName(f.path) }) : h('div', { class: 'empty' }, 'Image too large to preview.'));
  else if (f.binary) c.append(h('div', { class: 'empty' }, `Binary file (${f.size} bytes).`));
  else {
    if (f.truncated) c.append(h('div', { class: 'p-note' }, `Showing the first 2 MB of ${f.size} bytes.`));
    c.append(codeView(f.content, langFor(f.ext), { maxHeight: 'none' }));
  }
}

const relTo = (ws, p) => {
  const a = p.replace(/\\/g, '/');
  const b = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  return a.toLowerCase().startsWith(b.toLowerCase() + '/') ? a.slice(b.length + 1) : p;
};

/** Show the Changes panel, on the diff of `p` when git lists it (else the plain file). */
export async function reviewChanges(t, p) {
  showTab('changes');
  if (!p) return;
  await loadGit(true);
  const rel = relTo(t.workspace, p).replace(/\\/g, '/');
  const f = P.git?.files?.find((x) => x.path === rel);
  if (f) openDiff(t, f);
  else viewFile(t, p);
}

const gitSoon = debounce(() => {
  const t = activeTab();
  if (t && (P.tab === 'changes' || !P.git)) loadGit();
  else if (t) loadGit(true);
}, 900);

async function loadGit(quiet) {
  const t = activeTab();
  if (!t) return;
  const ws = t.workspace;
  P.busy = !quiet;
  if (!quiet && P.tab === 'changes') draw();
  try {
    const { git } = await api.get(`/api/git/status?ws=${encodeURIComponent(ws)}`);
    if (ws !== P.ws) return;
    P.git = git;
    P.gitErr = null;
  } catch (e) {
    P.gitErr = e.message;
  }
  P.busy = false;
  emit('git');
  drawTabs();
  if (P.tab === 'changes' && !P.diff) draw();
}

function drawChanges(t) {
  if (P.diff) return drawDiff(t);
  const g = P.git;
  body.append(h('div', { class: 'p-bar' }, icon('branch', 14), h('span', { class: 'grow ell mono' }, g?.repo ? `${g.branch}${g.upstream ? ' → ' + g.upstream : ''}${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}` : 'Changes'), iconBtn('refresh', 'Refresh', () => loadGit(), 'sm')));
  if (P.busy && !g) return body.append(skeleton(6, 'pad'));
  if (P.gitErr) return body.append(h('div', { class: 'empty err-text' }, P.gitErr));
  if (!g) return loadGit();
  if (g.gitMissing) return body.append(emptyState('branch', 'Git is not installed, so changes cannot be shown.'));
  if (!g.repo) return body.append(emptyState('branch', 'This folder is not a git repository.'));
  if (!g.files.length) return body.append(emptyState('check', 'No changes yet. The agent’s edits will appear here.'));
  const list = h('div', { class: 'p-scroll' });
  const paths = (files) => files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]));
  const letter = (f) => (f.untracked ? 'U' : f.x !== ' ' ? f.x : f.y);
  const row = (f, actions) => h('div', { class: 'gitem' },
    h('button', { class: 'gfile', type: 'button', title: f.path, onclick: () => openDiff(t, f) }, h('span', { class: `gs ${letter(f)}` }, letter(f)), h('span', { class: 'ell grow' }, h('bdi', null, f.path))),
    h('div', { class: 'gact' }, ...actions));
  const group = (label, files, all, rowActions) => files.length ? [
    h('div', { class: 'list-h gh' }, h('span', { class: 'grow' }, `${label} · ${files.length}`), all),
    ...files.map((f) => row(f, rowActions(f))),
  ] : [];
  const staged = g.files.filter((f) => f.staged);
  const changed = g.files.filter((f) => f.unstaged);
  const untracked = g.files.filter((f) => f.untracked);
  const stageBtn = (files, title) => iconBtn('plus', title, () => gitDo(t, 'stage', { paths: paths(files) }), 'sm');
  list.append(
    ...group('Staged', staged, iconBtn('minus', 'Unstage all', () => gitDo(t, 'unstage', { paths: paths(staged) }), 'sm'), (f) => [iconBtn('minus', 'Unstage', () => gitDo(t, 'unstage', { paths: paths([f]) }), 'sm')]),
    ...group('Changes', changed, stageBtn(changed, 'Stage all'), (f) => [iconBtn('undo', 'Discard changes', () => discardFiles(t, [f], false), 'sm'), stageBtn([f], 'Stage')]),
    ...group('Untracked', untracked, stageBtn(untracked, 'Stage all'), (f) => [iconBtn('trash', 'Delete file', () => discardFiles(t, [f], true), 'sm'), stageBtn([f], 'Stage')]),
  );
  body.append(list, commitBox(t, staged.length));
}

/** Run a git write, then show the new state. Errors (no identity, locked index, ...) are shown as they are. */
async function gitDo(t, what, extra) {
  try {
    return await api.post(`/api/git/${what}`, { ws: t.workspace, ...extra });
  } catch (e) {
    toast(e.message, 'error', 6000);
    return null;
  } finally {
    if (activeTab() === t) await loadGit(true);
  }
}

async function discardFiles(t, files, untracked) {
  const { confirmDialog } = await import('./dialogs.js');
  const f = files[0];
  const ok = await confirmDialog(untracked ? 'Delete this file?' : 'Discard these changes?', `${f.path}\n\n${untracked ? 'The file is deleted from disk.' : 'Your edits to the file are lost.'} This cannot be undone.`, { ok: untracked ? 'Delete' : 'Discard', danger: true });
  if (!ok) return;
  const paths = f.from ? [f.path, f.from] : [f.path];
  await gitDo(t, 'discard', untracked ? { untracked: paths } : { tracked: paths });
}

function commitBox(t, nStaged) {
  const ta = h('textarea', { class: 'commit-msg', rows: '2', placeholder: 'Commit message', 'aria-label': 'Commit message', spellcheck: 'true' });
  ta.value = P.msg;
  const go = h('button', { class: 'btn primary sm', type: 'button' }, 'Commit');
  const sync = () => {
    P.msg = ta.value;
    go.disabled = P.committing || !nStaged || !ta.value.trim();
    go.textContent = P.committing ? 'Committing…' : nStaged ? `Commit ${nStaged} file${nStaged === 1 ? '' : 's'}` : 'Commit';
    go.title = !nStaged ? 'Stage files first' : '';
  };
  const commit = async () => {
    if (go.disabled) return;
    P.committing = true;
    sync();
    const r = await gitDo(t, 'commit', { message: ta.value });
    P.committing = false;
    if (r) {
      P.msg = '';
      toast(`Committed${r.commit?.hash ? ' ' + r.commit.hash : ''}`, 'ok', 3000);
    }
    if (P.tab === 'changes' && !P.diff && activeTab() === t) draw();
  };
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), commit());
  });
  go.addEventListener('click', commit);
  sync();
  return h('div', { class: 'commit-box' }, ta, h('div', { class: 'commit-row' }, h('span', { class: 'commit-hint' }, 'Ctrl+Enter to commit'), go));
}

async function openDiff(t, f) {
  P.diff = { file: f, loading: true };
  draw();
  try {
    const { diff } = await api.get(`/api/git/diff?ws=${encodeURIComponent(t.workspace)}&file=${encodeURIComponent(f.path)}${f.untracked ? '&untracked=1' : ''}`);
    P.diff = { file: f, text: diff.text };
  } catch (e) {
    P.diff = { file: f, error: e.message };
  }
  if (P.tab === 'changes') draw();
}

function drawDiff(t) {
  const d = P.diff;
  body.append(h('div', { class: 'p-bar' }, iconBtn('chevron-left', 'Back to changes', () => { P.diff = null; draw(); }, 'sm'), h('span', { class: 'grow ell mono', title: d.file.path }, d.file.path), iconBtn('eye', 'View file', () => viewFile(t, d.file.path), 'sm')));
  const c = h('div', { class: 'p-scroll' });
  body.append(c);
  if (d.loading) c.append(skeleton(12, 'pad'));
  else if (d.error) c.append(h('div', { class: 'err-text' }, d.error));
  else if (!d.text.trim()) c.append(h('div', { class: 'empty' }, 'No text changes.'));
  else c.append(renderUnifiedDiff(d.text));
}

function drawTodos(t) {
  const total = (t.todos || []).flatMap((p) => p.tasks || []).length;
  if (!total) return body.append(emptyState('list', 'The agent’s task list appears here while it works.'));
  body.append(h('div', { class: 'p-scroll pad' }, todoList(t.todos)));
}

function drawAgents(t) {
  const list = [...t.subagents.values()];
  if (!list.length) return body.append(emptyState('users', 'Helper agents started for research appear here.'));
  list.sort((a, b) => (b.progress?.durationMs ? 0 : 1) - (a.progress?.durationMs ? 0 : 1));
  body.append(h('div', { class: 'p-scroll pad agents' }, list.map(agentRow)));
}

function drawConsole(t) {
  const out = h('div', { class: 'console-out' });
  const inp = h('input', { type: 'text', class: 'mono', placeholder: `Command in ${baseName(t.workspace)}`, 'aria-label': 'Shell command', spellcheck: 'false' });
  const paint = () => {
    replace(out, t.console.length ? t.console.map((c) => h('div', { class: 'con-entry' }, h('div', { class: 'cmdl' }, '$ ' + c.cmd, c.code ? h('span', { class: 'tool-exit num' }, `exit ${c.code}`) : null), h('pre', { class: c.code ? 'err' : null }, c.out == null ? '…' : ansiFragment(c.out)))) : emptyState('terminal', 'Run a shell command in the project folder. The output is added to the conversation.'));
    out.scrollTop = out.scrollHeight;
  };
  inp.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !inp.value.trim() || t.dead) return;
    const entry = { cmd: inp.value.trim(), out: null };
    inp.value = '';
    t.console.push(entry);
    paint();
    try {
      const r = await rpc(t.id, { type: 'bash', command: entry.cmd });
      entry.out = String(r.data?.output ?? '').replace(/\n?\[exit code -?\d+\]\s*$/, '') || '(no output)';
      entry.code = r.data?.exitCode;
    } catch (er) {
      entry.out = er.message;
      entry.code = 1;
    }
    if (P.tab === 'console' && activeTab() === t) paint();
    emit('tab:panel', t, 'git');
  });
  body.append(out, h('div', { class: 'console-in' }, h('span', { class: 'prompt', 'aria-hidden': 'true' }, '$'), inp, iconBtn('stop', 'Stop the running command', () => rpc(t.id, { type: 'abort_bash' }).catch(() => {}), 'sm')));
  paint();
}
