// Right-hand panel: Files, Changes (git), Todos, Agents, Console.
import { h, icon, iconBtn, replace, clear, toast, skeleton, baseName, copyText, debounce, errorState } from './dom.js';
import { asciiArt } from './ascii.js';
import { api, rpc } from './api.js';
import { S, activeTab, emit, on, savePrefs } from './store.js';
import { codeView, renderUnifiedDiff, todoList, agentRow } from './tools.js';
import { langFor } from './highlight.js';
import { ansiFragment } from './ansi.js';
import { runInspector } from './run-inspector.js';
import { coalesce } from './coalesce.mjs';
import { drawReview, loadReview, reviewCount } from './review.js';
import { workingRuns } from './runs.js';
import { renderMarkdown } from './markdown.js';
import { asciiBar } from './ascii.js';
import { openLink } from './engine.js';

const P = { tab: 'home', file: null, diff: null, git: null, gitErr: null, msg: '', committing: false, tree: new Map(), open: new Set(), ws: null, busy: false };
let root;
let body;
let tabsEl;
let inspector = null;

const ALL_TABS = [['home', 'Overview', 'overview'], ['run', 'Run', 'activity'], ['review', 'Review', 'check'], ['files', 'Files', 'folder'], ['changes', 'Changes', 'branch'], ['todos', 'Plan', 'list'], ['agents', 'Agents', 'users'], ['ask', 'Side question', 'message'], ['console', 'Console', 'terminal'], ['browser', 'Browser', 'globe']];
// Review is there for a session on its own branch only.
let TABS = ALL_TABS.filter(([k]) => k !== 'review');
function syncTabs(t) {
  TABS = ALL_TABS.filter(([k]) => k !== 'review' || !!t?.worktree);
  if (!TABS.some(([k]) => k === P.tab)) P.tab = 'changes';
}

export function mountPanel(el) {
  root = el;
  if (ALL_TABS.some(([k]) => k === S.ui.rightTab)) P.tab = S.ui.rightTab;
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
    if ((kind === 'todos' && P.tab === 'todos') || (kind === 'agents' && P.tab === 'agents') || (kind === 'review' && P.tab === 'review') || (P.tab === 'home' && kind !== 'git')) draw();
    if ((kind === 'git' || kind === 'review') && tab.worktree && P.tab === 'review') loadReview(tab, reviewRedraw);
    drawTabs();
  });
  on('tab:state', (tab) => tab === activeTab() && drawTabs());
  on('runs', () => P.tab === 'home' && activeTab() && draw());
  on('panel:badges', () => P.tab === 'home' && activeTab() && body.querySelector('.ph') && homeCounts());
  const refreshRun = coalesce((tab) => { if (!document.hidden && tab === activeTab() && P.tab === 'run') inspector?.update(tab); });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&P.tab==='run'&&activeTab())inspector?.update(activeTab());});
  for (const event of ['tab:tool','tab:state','tab:status','tab:messages']) on(event, refreshRun);
  resetFor(activeTab());
}

const reviewRedraw = () => {
  if (P.tab === 'review') draw();
  drawTabs();
};

function resetFor(tab) {
  syncTabs(tab);
  const ws = tab?.workspace || null;
  if (ws !== P.ws) {
    Object.assign(P, { ws, file: null, diff: null, git: null, gitErr: null, tree: new Map(), open: new Set() });
    emit('git');
  }
  drawTabs();
  draw();
  if (tab) loadGit(P.tab !== 'changes'); // the toolbar shows the branch, so load it for every tab
}

/** Git status of the active project, once loaded (for the toolbar's branch). */
export const gitState = (ws) => (ws && ws === P.ws ? P.git : null);

export function showTab(name) {
  P.tab = name;
  P.file = null;
  P.diff = null;
  drawTabs();
  draw();
  if (name === 'changes') loadGit();
  if (name === 'review' && activeTab()?.worktree) loadReview(activeTab(), reviewRedraw);
  savePrefs({ rightTab: name, rightPanel: true });
  emit('panel:open');
  if (name === 'console') setTimeout(() => body.querySelector('.console-in input')?.focus(), 0);
}

/** The panel's tabs for a session and the counts on them (also shown on the Overview card). */
export function panelInfo(t) {
  syncTabs(t);
  const nChanges = P.git?.files?.length || 0;
  const nTodo = (t?.todos || []).flatMap((p) => p.tasks || []).filter((x) => x.status !== 'completed' && x.status !== 'abandoned').length;
  const nAg = [...(t?.subagents?.values() || [])].filter((a) => /running|started|pending/.test(a.progress?.status || a.status || '')).length;
  return { tabs: TABS, badge: { changes: nChanges, todos: nTodo, agents: nAg, review: reviewCount(t) } };
}

function drawTabs() {
  const t = activeTab();
  const { badge } = panelInfo(t);
  queueMicrotask(() => emit('panel:badges'));
  replace(tabsEl, TABS.map(([k, l, ic], index) => h('button', { class: 'ptab' + (P.tab === k ? ' cur' : ''), type: 'button', role: 'tab', 'aria-label':l, tabindex:P.tab===k?'0':'-1', 'aria-selected': String(P.tab === k), title: l, onclick: () => showTab(k), onkeydown:e=>{
    let next;
    if(e.key==='ArrowRight')next=(index+1)%TABS.length;
    else if(e.key==='ArrowLeft')next=(index+TABS.length-1)%TABS.length;
    else if(e.key==='Home')next=0;else if(e.key==='End')next=TABS.length-1;
    if(next==null)return;e.preventDefault();showTab(TABS[next][0]);tabsEl.children[next]?.focus();
  } }, icon(ic, 14), h('span', { class: 'lbl' }, l), badge[k] ? h('span', { class: 'badge num' }, badge[k]) : null)));
}

function draw() {
  const t = activeTab();
  clear(body);
  inspector = null;
  if (!t) return;
  if (P.tab === 'run') { inspector = runInspector(t, () => showTab('changes')); body.append(inspector.el); return; }
  ({ home: drawHome, ask: drawAsk, browser: drawBrowser, files: drawFiles, changes: drawChanges, todos: drawTodos, agents: drawAgents, console: drawConsole, review: (x) => drawReview(x, body, { redraw: reviewRedraw, viewFile }) })[P.tab](t);
}

/**
 * The panel's first page: find a file, the panel's tools with their counts, the helper agents of this conversation
 * and the runs working now. Everything else in the panel starts from here.
 */
/** Refresh the counts on the home page in place (git status arrives after it is drawn). */
function homeCounts() {
  const { badge } = panelInfo(activeTab());
  for (const el of body.querySelectorAll('.ph-it[data-k]')) {
    const n = badge[el.dataset.k] || 0;
    let c = el.querySelector('.ph-n');
    if (!n) c?.remove();
    else if (c) c.textContent = n;
    else el.append(h('span', { class: 'ph-n num' }, n));
  }
}

function drawHome(t) {
  const { tabs, badge } = panelInfo(t);
  const find = h('button', { class: 'ph-find', type: 'button', onclick: () => emit('search', 'files') }, icon('search', 14), h('span', { class: 'grow' }, `Find a file in ${baseName(t.workspace) || 'the project'}`), h('kbd', null, 'Ctrl+K'));
  const ITEMS = { review: ['Review', 'check'], changes: ['Changes', 'branch'], files: ['Open file', 'file'], console: ['Terminal', 'terminal'], ask: ['Side question', 'message'], browser: ['Browser', 'globe'], todos: ['Plan', 'list'], run: ['Inspect', 'activity'] };
  const have = new Set(tabs.map(([k]) => k));
  const items = ['review', 'changes', 'files', 'console', 'browser', 'ask', 'todos', 'run'].filter((k) => have.has(k)).map((k) => h('button', { class: 'ph-it', type: 'button', dataset: { k }, onclick: () => showTab(k) }, icon(ITEMS[k][1], 15), h('span', { class: 'grow' }, ITEMS[k][0]), badge[k] ? h('span', { class: 'ph-n num' }, badge[k]) : null));
  const helpers = [...(t.subagents?.values() || [])];
  const runs = workingRuns();
  const section = (title, n, rows, more) => h('section', { class: 'ph-sec' }, h('h4', null, title, h('span', { class: 'ph-n num' }, n)), rows, more || null);
  body.append(h('div', { class: 'p-scroll ph' },
    find,
    h('nav', { class: 'ph-list', 'aria-label': 'Panel' }, items),
    helpers.length ? section('Subagents', helpers.length, helpers.slice(0, 5).map((a) => {
      const p = a.progress || a;
      const st = p.status || a.status || 'pending';
      const live = /running|started|pending/.test(st);
      return h('button', { class: 'ph-row', type: 'button', onclick: () => showTab('agents'), title: (p.assignment || p.task || '').toString().slice(0, 300) }, live ? h('span', { class: 'dot run' }) : icon(/fail|error/.test(st) ? 'x' : 'check', 13), h('span', { class: 'ell' }, (p.assignment || p.task || p.id || 'Helper').toString().split('\n')[0]));
    }), helpers.length > 5 ? h('button', { class: 'ph-more', type: 'button', onclick: () => showTab('agents') }, 'See all') : null) : null,
    runs.length ? section('Background runs', runs.length, runs.slice(0, 5).map((r) => h('button', { class: 'ph-row', type: 'button', onclick: () => emit('open-run', r.id) }, h('span', { class: 'dot run' }), h('span', { class: 'ell' }, r.title))), runs.length > 5 ? h('button', { class: 'ph-more', type: 'button', onclick: () => emit('open-run', null) }, 'See all') : null) : null));
}

/**
 * Side question (/btw): ask about the conversation without interrupting it. The answer comes from the conversation so
 * far, with no tools, and is not added to it. Questions and answers stay in this panel while the window is open.
 */
export async function askSide(t, q) {
  const text = String(q || '').trim();
  if (!text || t.dead) return;
  t.sideQA ||= [];
  const item = { q: text, a: '', at: Date.now(), busy: true };
  t.sideQA.push(item);
  // Show the answer where it lands: open the panel on Side question, also when it was closed or is a narrow overlay.
  if (P.tab !== 'ask' || !document.querySelector('#panel')?.getClientRects().length) showTab('ask');
  else if (activeTab() === t) draw();
  try {
    const r = await rpc(t.id, { type: 'side_question', text }, 130000);
    if (r?.success === false || r?.ok === false) throw new Error(r.error || 'The model could not answer');
    item.a = r?.data?.text || '';
    item.model = r?.data?.model || '';
  } catch (e) {
    item.err = e.message;
  }
  item.busy = false;
  if (activeTab() === t && P.tab === 'ask') draw();
}

function drawAsk(t) {
  const list = t.sideQA || [];
  const box = h('textarea', { class: 'ask-in', rows: 2, placeholder: 'Ask about this conversation. The agent keeps working.', 'aria-label': 'Side question' });
  const send = () => {
    const q = box.value;
    box.value = '';
    askSide(t, q);
  };
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) (e.preventDefault(), send());
  });
  const log = h('div', { class: 'p-scroll pad ask-log' },
    list.length ? list.map((it) => h('div', { class: 'ask-qa' },
      h('div', { class: 'ask-q' }, it.q),
      it.busy ? h('div', { class: 'pending' }, asciiBar(), h('span', { class: 'pending-l' }, 'Thinking'))
        : it.err ? h('div', { class: 'ask-err' }, it.err)
        : h('div', { class: 'ask-a' }, renderMarkdown(it.a), it.model ? h('div', { class: 'ask-m' }, it.model) : null))) : emptyState('users', 'Ask a quick question about this conversation, even while the agent works: what it changed, why, where something is. It answers without tools and does not add to the conversation. You can also type /btw in the message box.'));
  body.append(log, h('div', { class: 'ask-bar' }, box, iconBtn('send', 'Ask (Enter)', send, 'ask-go')));
  log.scrollTop = log.scrollHeight;
  setTimeout(() => box.focus({ preventScroll: true }), 0);
}

/** Is this an http page on this computer? Only those show inside ORBIX (see frame-src in server.mjs). */
const localPage = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1');
  } catch {
    return false;
  }
};

/**
 * Browser: preview the web app you are building, in the panel. It lists the dev servers running on this computer
 * (Vite, Next, Django…) and shows one in a sandboxed frame. Other sites, and searches, open in your own browser.
 */
function drawBrowser(t) {
  const st = (t.browser ||= { url: '' });
  const input = h('input', { class: 'br-url', type: 'text', value: st.url, placeholder: 'Search or enter a URL', 'aria-label': 'Address', spellcheck: false, autocomplete: 'off' });
  const go = (raw) => {
    let v = String(raw || '').trim();
    if (!v) return;
    if (/^\d{2,5}$/.test(v)) v = `http://localhost:${v}/`;
    else if (/^(localhost|127\.0\.0\.1)([:/]|$)/i.test(v)) v = `http://${v}`;
    else if (!/^https?:\/\//i.test(v)) v = /^[^\s/]+\.[a-z]{2,}(\/\S*)?$/i.test(v) ? `https://${v}` : `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
    if (localPage(v)) {
      st.url = v;
      return draw();
    }
    openLink(v);
    toast('Opened in your browser. The panel shows only apps running on this computer.', 'ok', 2600);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), go(input.value));
  });
  const frame = st.url ? h('iframe', { class: 'br-frame', src: st.url, title: `Preview of ${st.url}`, sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals', referrerpolicy: 'no-referrer' }) : null;
  body.append(h('div', { class: 'p-bar br-bar' },
    st.url ? iconBtn('arrow-left', 'Back to the list of running apps', () => ((st.url = ''), draw()), 'sm') : null,
    input,
    st.url ? iconBtn('refresh', 'Reload', () => (frame.src = st.url), 'sm') : iconBtn('refresh', 'Look again for running apps', () => draw(), 'sm'),
    st.url ? iconBtn('external', 'Open in your browser', () => openLink(st.url), 'sm') : null));
  if (frame) return body.append(h('div', { class: 'br-view' }, frame));
  const list = h('div', { class: 'p-scroll pad br-list' }, skeleton(3));
  body.append(list);
  api.get('/api/devservers').then(({ servers }) => {
    if (!list.isConnected) return;
    replace(list,
      servers.length ? h('h4', { class: 'br-h' }, 'Running on this computer') : null,
      servers.length ? servers.map((s) => h('button', { class: 'ph-row br-row', type: 'button', title: s.url, onclick: () => go(s.url) }, h('span', { class: 'dot ok' }), h('span', { class: 'ell grow' }, s.title || `localhost:${s.port}`), h('span', { class: 'muted num' }, `:${s.port}`)))
        : emptyState('files', 'No web app is running on the usual ports (3000, 5173, 8000, 8080…). Start your dev server, or ask the agent to, then look again. You can also type a port or a localhost address above.'));
  }, (e) => list.isConnected && replace(list, errorState(e.message, { retry: () => draw() })));
  setTimeout(() => input.focus({ preventScroll: true }), 0);
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
      host.append(errorState(e.message, { title: 'Couldn’t list this folder.', retry: () => { P.tree.delete(dir); draw(); } }));
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
  else if (f.error) c.append(errorState(f.error, { title: 'Couldn’t open this file.', retry: () => viewFile(t, f.path) }));
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
  if (P.gitErr) return body.append(errorState(P.gitErr, { title: 'Couldn’t read the changes.', retry: () => loadGit() }));
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
  else if (d.error) c.append(errorState(d.error, { title: 'Couldn’t load this diff.', retry: () => openDiff(t, d.file) }));
  else if (!d.text.trim()) c.append(h('div', { class: 'empty' }, 'No text changes.'));
  else c.append(renderUnifiedDiff(d.text, d.file.path));
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
