// Side panel: Review (a branch session), Changes (git), Files, Terminal, Browser, Tasks (with helper agents), Inspect
// and Side question. It works for the open conversation, and on Home for the project chosen there (Changes, Files,
// Terminal and Browser, which need no conversation).
import { h, icon, iconBtn, replace, clear, toast, skeleton, baseName, copyText, debounce, errorState, fmtTokens, fmtCost } from './dom.js';
import { asciiSpin } from './ascii.js';
import { api, rpc } from './api.js';
import { S, activeTab, emit, on, savePrefs, sendPrompt } from './store.js';
import { homeProject } from './home.js';
import { codeView, renderUnifiedDiff, todoList, agentRow } from './tools.js';
import { langFor } from './highlight.js';
import { runInspector } from './run-inspector.js';
import { coalesce } from './coalesce.mjs';
import { drawReview, loadReview, reviewCount } from './review.js';
import { workingRuns } from './runs.js';
import { renderMarkdown } from './markdown.js';
import { openLink } from './engine.js';
import { desktopBrowser, canShowInside, addressToUrl, rememberVisit } from './browser.js';
import { btn } from './dialogs.js';
import { drawTerminal } from './terminal.js';
import { effectiveKeys } from './keys.mjs';

const P = { tab: 'changes', file: null, diff: null, git: null, gitErr: null, msg: '', committing: false, tree: new Map(), open: new Set(), ws: null, busy: false };
let root;
let body;
let tabsEl;
let inspector = null;

const ALL_TABS = [['review', 'Review', 'check'], ['changes', 'Changes', 'branch'], ['files', 'Files', 'folder'], ['console', 'Terminal', 'terminal'], ['browser', 'Browser', 'globe'], ['todos', 'Tasks', 'list'], ['run', 'Inspect', 'activity'], ['ask', 'Side question', 'message'], ['context', 'Context', 'gauge'], ['new', 'New tab', 'compass']];
const HOME_TABS = new Set(['changes', 'files', 'console', 'browser', 'new']);
const DEFAULT_OPEN = ['changes', 'files', 'console', 'browser'];
// The panel's tabs are the surfaces you opened, in order, like a browser's (kept across restarts). "+" adds a New tab
// page that lists every surface; picking one turns it into that surface. TABS: the open ones this view can show.
let OPEN = [...DEFAULT_OPEN];
let TABS = [];
const known = (k) => ALL_TABS.some(([x]) => x === k);
/** Review is there for a session on its own branch only; on Home, only the surfaces that need no conversation. */
const allowed = (k, t) => (k !== 'review' || !!t?.worktree) && (!t?.home || HOME_TABS.has(k));
function syncTabs(t) {
  TABS = OPEN.filter((k) => allowed(k, t)).map((k) => ALL_TABS.find(([x]) => x === k));
  if (!TABS.length) TABS = [ALL_TABS.find(([x]) => x === 'new')];
  if (!TABS.some(([k]) => k === P.tab)) P.tab = TABS[0][0];
}
const saveOpen = () => savePrefs({ panelTabs: OPEN.filter((k) => k !== 'new') });

// What the panel is for: the open conversation, or on Home the project chosen there (one stable object per folder, so
// its browser keeps its page while you switch away and back).
const homeCtx = new Map();
function cur() {
  const t = activeTab();
  if (t) return t;
  const ws = homeProject();
  if (!ws) return null;
  if (!homeCtx.has(ws)) homeCtx.set(ws, { home: true, id: `home-${homeCtx.size}`, workspace: ws, todos: [], subagents: new Map() });
  return homeCtx.get(ws);
}

export function mountPanel(el) {
  root = el;
  if (Array.isArray(S.ui.panelTabs)) OPEN = [...new Set(S.ui.panelTabs.filter((k) => known(k) && k !== 'new'))];
  P.tab = OPEN.includes(S.ui.rightTab) ? S.ui.rightTab : OPEN[0] || 'new';
  if (!OPEN.length) OPEN = ['new'];
  tabsEl = h('div', { class: 'ptabs', role: 'tablist', 'aria-label': 'Side panel' });
  body = h('div', { class: 'pbody' });
  root.append(tabsEl, body);
  on('active', () => resetFor(cur()));
  on('home:project', () => !activeTab() && resetFor(cur()));
  // A link from a reply, with Settings → Browser → Open links in: Built-in browser.
  on('browse', (url) => {
    const t = cur();
    if (!t) return;
    const st = (t.browser ||= { url: '', view: null });
    if (st.view && window.orbixDesktop?.browser) st.view.loadURL(url).catch(() => {});
    else st.view = null;
    st.url = url;
    if (P.tab === 'browser' && document.querySelector('#panel')?.getClientRects().length) draw();
    else showTab('browser');
  });
  on('tab:panel', (tab, kind) => {
    if (tab !== activeTab()) return;
    if (kind === 'git') {
      gitSoon();
      P.tree.clear(); // the agent may have created or removed files
      if (P.tab === 'files' && !P.file) draw();
    }
    if (((kind === 'todos' || kind === 'agents') && P.tab === 'todos') || (kind === 'review' && P.tab === 'review')) draw();
    if ((kind === 'git' || kind === 'review') && tab.worktree && P.tab === 'review') loadReview(tab, reviewRedraw);
    drawTabs();
  });
  on('tab:state', (tab) => tab === activeTab() && drawTabs());
  const refreshRun = coalesce((tab) => { if (!document.hidden && tab === activeTab() && P.tab === 'run') inspector?.update(tab); });
  // The Context tab follows the conversation's numbers (a few times a second at most).
  const refreshCtx = coalesce((tab) => { if (!document.hidden && tab === activeTab() && P.tab === 'context') fillContext(tab); });
  for (const event of ['tab:state', 'tab:status']) on(event, refreshCtx);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&P.tab==='run'&&activeTab())inspector?.update(activeTab());});
  for (const event of ['tab:tool','tab:state','tab:status','tab:messages']) on(event, refreshRun);
  resetFor(cur());
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
  emit('panel:subject');
}

let focusTerm = false; // the Terminal takes the keyboard when you open its tab, not when the panel redraws
/** The side panel's current tab. */
export const panelTab = () => P.tab;

/** Git status of the active project, once loaded (for the toolbar's branch). */
export const gitState = (ws) => (ws && ws === P.ws ? P.git : null);

/** Show surface `name`, opening its tab (next to the current one, or in place of a New tab) when it is not open. */
export function showTab(name) {
  const t = cur();
  if (!known(name) || !allowed(name, t)) name = allowed('changes', t) ? 'changes' : 'new';
  if (!OPEN.includes(name)) {
    const i = OPEN.indexOf(P.tab);
    if (P.tab === 'new' && i >= 0) OPEN.splice(i, 1, name);
    else OPEN.splice(i >= 0 ? i + 1 : OPEN.length, 0, name);
    fresh = name;
    saveOpen();
  } else if (P.tab === 'new' && name !== 'new') {
    // A New tab turns into what you pick there; when that is already open, the New tab closes and it comes forward.
    OPEN = OPEN.filter((k) => k !== 'new');
    saveOpen();
  }
  syncTabs(t);
  P.tab = name;
  P.file = null;
  P.diff = null;
  drawTabs();
  focusTerm = name === 'console';
  draw();
  // The new surface settles in (once per switch, not on every refresh of its content).
  body.classList.remove('enter');
  void body.offsetWidth;
  body.classList.add('enter');
  if (name === 'changes') loadGit();
  if (name === 'review' && activeTab()?.worktree) loadReview(activeTab(), reviewRedraw);
  savePrefs({ rightTab: name, rightPanel: true });
  emit('panel:open');
  focusTerm = false;
  const field = { ask: '.ask-in', browser: '.br-url', new: '.nt-it:not(.off)' }[name];
  const input = field && body.querySelector(field);
  if (input) queueMicrotask(() => input.isConnected && input.focus({ preventScroll: true }));
}

let fresh = ''; // the tab just opened, which grows in once

/** "+": a New tab page next to the current tab (or the one already open). */
function newPanelTab() {
  if (!OPEN.includes('new')) {
    const i = OPEN.indexOf(P.tab);
    OPEN.splice(i >= 0 ? i + 1 : OPEN.length, 0, 'new');
    fresh = 'new';
  }
  showTab('new');
}

/** Close tab `k`: the one beside it takes its place; the last one closed leaves a New tab. */
function closePanelTab(k) {
  const t = cur();
  const shown = TABS.map(([x]) => x);
  const at = shown.indexOf(k);
  const wasCur = P.tab === k;
  OPEN = OPEN.filter((x) => x !== k);
  if (!OPEN.some((x) => allowed(x, t))) OPEN.push('new');
  saveOpen();
  if (!wasCur) return drawTabs();
  syncTabs(t);
  const left = TABS.map(([x]) => x);
  showTab(left[Math.min(at, left.length - 1)] || 'new');
}

/** The counts on the tabs: changed files, open tasks plus working helper agents (both under Tasks), files to review. */
function badges(t) {
  syncTabs(t);
  const nTodo = (t?.todos || []).flatMap((p) => p.tasks || []).filter((x) => x.status !== 'completed' && x.status !== 'abandoned').length;
  const nAg = [...(t?.subagents?.values() || [])].filter((a) => /running|started|pending/.test(a.progress?.status || a.status || '')).length;
  return { changes: P.git?.files?.length || 0, todos: nTodo + nAg, review: reviewCount(t) };
}

/** The next (1) or previous (-1) side panel tab; opens the panel when it is closed. */
export function stepPanelTab(dir) {
  syncTabs(cur());
  const i = TABS.findIndex(([k]) => k === P.tab);
  showTab(TABS[(i + dir + TABS.length) % TABS.length][0]);
}

// ---------------------------------------------------------------- surfaces
/**
 * Everything the panel can show, with the shortcut that opens it from anywhere (Settings → Shortcuts changes them).
 * The New tab page lists them; a surface that needs a conversation is dimmed with the reason.
 */
function surfaces(t) {
  const conv = !!t && !t.home;
  return [
    { id: 'surfReview', icon: 'check', label: 'Review', off: !t?.worktree, why: 'For a conversation on its own branch', run: () => showTab('review') },
    { id: 'surfBrowser', icon: 'globe', label: 'Browser', run: () => openBrowser(t, { incog: false, device: false }) },
    { id: 'surfIncognito', icon: 'incognito', label: 'Incognito browser', note: 'Keeps nothing after ORBIX closes', run: () => openBrowser(t, { incog: true, device: false }) },
    { id: 'terminal', icon: 'terminal', label: 'Terminal', run: () => showTab('console') },
    { id: 'files', icon: 'search', label: 'Open file', off: !conv, why: 'Open a conversation first', run: () => emit('search', 'files') },
    { id: 'surfFiles', icon: 'folder', label: 'Files', run: () => showTab('files') },
    { id: 'surfChanges', icon: 'branch', label: 'Changes', run: () => showTab('changes') },
    { id: 'surfTasks', icon: 'list', label: 'Tasks', off: !conv, why: 'Open a conversation first', run: () => showTab('todos') },
    { id: 'inspector', icon: 'activity', label: 'Inspect', off: !conv, why: 'Open a conversation first', run: () => showTab('run') },
    { id: 'surfDevice', icon: 'smartphone', label: 'Device', note: 'The page at phone size', run: () => openBrowser(t, { incog: !!t?.browser?.incog, device: true }) },
    { id: 'sideQuestion', icon: 'message', label: 'Side question', off: !conv, why: 'Open a conversation first', run: () => showTab('ask') },
    { id: 'surfContext', icon: 'gauge', label: 'Context', note: 'Tokens, cost and the system prompt', off: !conv, why: 'Open a conversation first', run: () => showTab('context') },
  ];
}

/** Open surface `id` (a shortcut, or a row of the New tab page). */
export function openSurface(id) {
  const t = cur();
  if (!t) return toast('Open a project first.', 'info', 2200);
  const it = surfaces(t).find((x) => x.id === id);
  if (!it) return;
  if (it.off) return toast(`${it.label}: ${it.why}.`, 'info', 2400);
  it.run();
}

/** The keys of a surface: its Ctrl+Alt one when it has one, else the first. */
const surfaceKey = (id) => {
  const ks = effectiveKeys(S.ui.keys)[id] || [];
  return ks.find((k) => k.startsWith('Ctrl+Alt+')) || ks[0] || '';
};

/** Open the Browser surface in a mode; a different mode starts a fresh view (its own session). */
function openBrowser(t, { incog, device }) {
  const st = (t.browser ||= { url: '', view: null });
  if (!!st.incog !== incog || incog) {
    st.view = null; // a new <webview> on the other session; each Incognito view starts with a fresh one
    if (incog) (st.url = ''), (st.incogN = (st.incogN || 0) + 1);
  }
  if (!!st.device !== device) st.view = null; // the phone's user agent is set when the view is made
  st.incog = incog;
  st.device = device;
  if (P.tab === 'browser') draw();
  showTab('browser');
}

/** The New tab page: every surface as a row with its shortcut. ↑ ↓ move, Enter opens. */
function drawNew(t) {
  const rows = surfaces(t).map((it, i) => {
    const key = surfaceKey(it.id);
    const b = h('button', { class: 'nt-it' + (it.off ? ' off' : ''), type: 'button', title: it.off ? it.why : it.note || null, 'aria-disabled': it.off ? 'true' : null, 'aria-keyshortcuts': key || null, onclick: () => (it.off ? toast(`${it.label}: ${it.why}.`, 'info', 2400) : it.run()) },
      icon(it.icon, 15), h('span', { class: 'nt-l grow' }, it.label, it.note ? h('small', null, it.note) : null),
      key ? h('span', { class: 'nt-k' }, key.split('+').map((k) => h('kbd', null, k === 'Ctrl' ? 'Ctrl' : k))) : null);
    b.style.setProperty('--i', i);
    return b;
  });
  const list = h('div', { class: 'nt-list', role: 'list', 'aria-label': 'Open a surface' }, rows);
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = rows.filter((x) => !x.classList.contains('off'));
    const i = all.indexOf(document.activeElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  });
  body.append(h('div', { class: 'p-scroll nt-page' }, list));
}

function drawTabs() {
  const t = cur();
  const badge = badges(t);
  const tabs = TABS.map(([k, l, ic], index) => {
    const tab = h('button', { class: 'ptab' + (P.tab === k ? ' cur' : ''), type: 'button', role: 'tab', 'aria-label': l, tabindex: P.tab === k ? '0' : '-1', 'aria-selected': String(P.tab === k), title: l, onclick: () => showTab(k), onauxclick: (e) => e.button === 1 && (e.preventDefault(), closePanelTab(k)), onkeydown: (e) => {
      if (e.key === 'Delete') return e.preventDefault(), closePanelTab(k);
      let next;
      if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next == null) return;
      e.preventDefault();
      showTab(TABS[next][0]);
      tabsEl.querySelectorAll('.ptab')[next]?.focus();
    } }, icon(ic, 14), h('span', { class: 'lbl ell' }, l), badge[k] ? h('span', { class: 'badge num' }, badge[k]) : null);
    const x = h('button', { class: 'ptab-x', type: 'button', tabindex: '-1', title: `Close ${l} (Delete)`, 'aria-label': `Close ${l}`, onclick: () => closePanelTab(k) }, icon('x', 12));
    return h('div', { class: 'ptab-w' + (P.tab === k ? ' cur' : '') + (fresh === k ? ' fresh' : '') }, tab, x);
  });
  fresh = '';
  const plus = h('button', { class: 'ptab-new', type: 'button', title: 'New tab', 'aria-label': 'New tab', onclick: newPanelTab }, icon('plus', 14));
  replace(tabsEl, tabs, plus);
}

function draw() {
  const t = cur();
  clear(body);
  inspector = null;
  if (!t) return;
  if (P.tab === 'run') { inspector = runInspector(t, () => showTab('changes')); body.append(inspector.el); return; }
  ({ new: drawNew, context: drawContext, ask: drawAsk, browser: drawBrowser, files: drawFiles, changes: drawChanges, todos: drawTodos, console: (x) => drawTerminal(body, { focus: focusTerm }), review: (x) => drawReview(x, body, { redraw: reviewRedraw, viewFile }) })[P.tab](t);
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
      it.busy ? h('div', { class: 'pending' }, asciiSpin(), h('span', { class: 'pending-l' }, 'Thinking'))
        : it.err ? h('div', { class: 'ask-err' }, it.err)
        : h('div', { class: 'ask-a' }, renderMarkdown(it.a), it.model ? h('div', { class: 'ask-m' }, it.model) : null))) : emptyState('message', 'Ask a quick question about this conversation, even while the agent works: what it changed, why, where something is. It answers without tools and does not add to the conversation. You can also type /btw in the message box.'));
  body.append(log, h('div', { class: 'ask-bar' }, box, iconBtn('send', 'Ask (Enter)', send, 'ask-go')));
  log.scrollTop = log.scrollHeight;
}

/**
 * Browser: a web page next to the conversation. It starts on the web apps running on this computer (Vite, Next,
 * Django…). In the Windows app it is a real browser view with its own session (any site, back and forward, downloads);
 * in a web browser it can show only this computer's pages, in a sandboxed frame. What it cannot show opens in your
 * own browser. Each conversation keeps its own page.
 */
// A phone, for Device: its size and a mobile browser's user agent, so sites send their phone layout.
const PHONE = { w: 393, h: 852, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

function drawBrowser(t) {
  const st = (t.browser ||= { url: '', view: null });
  const desk = desktopBrowser();
  const modeChips = () => [
    st.incog ? h('span', { class: 'br-chip incog', title: 'Incognito: no history, cookies or cache are kept after ORBIX closes' }, icon('incognito', 13), 'Incognito') : null,
    iconBtn('smartphone', st.device ? 'Device: on (phone size). Click for full width' : 'Device: show the page at phone size', () => openBrowser(t, { incog: !!st.incog, device: !st.device }), 'sm br-dev' + (st.device ? ' on' : '')),
  ];
  const sugg = h('datalist', { id: `br-hist-${t.id}` }, (S.ui.browserHistory || []).slice(0, 30).map((u) => h('option', { value: u })));
  const input = h('input', { class: 'br-url', type: 'text', value: st.url, placeholder: 'Search or enter a URL', 'aria-label': 'Address', spellcheck: false, autocomplete: 'off', list: sugg.id });
  const go = (raw) => {
    const v = addressToUrl(raw);
    if (!v) return;
    if (!canShowInside(v)) {
      openLink(v);
      return toast('Opened in your browser. In a web browser, ORBIX shows only pages on this computer.', 'ok', 2600);
    }
    if (!st.incog) rememberVisit(v);
    if (st.view && st.url && desk) {
      st.url = v;
      input.value = v;
      return st.view.loadURL(v).catch(() => {});
    }
    st.url = v;
    draw();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), go(input.value));
    if (e.key === 'Escape' && input.value !== st.url) (e.preventDefault(), e.stopPropagation(), (input.value = st.url));
  });
  input.addEventListener('focus', () => input.select());
  if (!st.url) {
    body.append(h('div', { class: 'p-bar br-bar' }, input, ...modeChips(), iconBtn('refresh', 'Look again for running apps', () => draw(), 'sm')), sugg);
    if (st.incog) body.append(h('div', { class: 'br-note' }, icon('incognito', 14), h('span', null, 'Incognito. Pages you open here share no sign-ins with the default browser, and their history, cookies and cache are forgotten when ORBIX closes.')));
    const list = h('div', { class: 'p-scroll pad br-list' }, skeleton(3));
    body.append(list);
    api.get('/api/devservers').then(({ servers }) => {
      if (!list.isConnected) return;
      replace(list,
        servers.length ? h('h4', { class: 'br-h' }, 'Running on this computer') : null,
        servers.length ? servers.map((s) => h('button', { class: 'br-row', type: 'button', title: s.url, onclick: () => go(s.url) }, h('span', { class: 'dot ok' }), h('span', { class: 'ell grow' }, s.title || `localhost:${s.port}`), h('span', { class: 'muted num' }, `:${s.port}`)))
          : emptyState('globe', `No web app is running on the usual ports (3000, 5173, 8000, 8080…). Start your dev server, or ask the agent to, then look again. ${desk ? 'You can also type any address or a search above.' : 'You can also type a port or a localhost address above.'}`));
    }, (e) => list.isConnected && replace(list, errorState(e.message, { retry: () => draw() })));
    return;
  }
  const home = iconBtn('layers', 'Running apps', () => {
    st.url = '';
    st.view = null;
    draw();
  }, 'sm');
  const ext = iconBtn('external', 'Open in your browser', () => openLink(st.url), 'sm');
  if (!desk) {
    // A web browser: this computer's pages in a sandboxed frame. The frame's own history is out of reach.
    const frame = h('iframe', { class: 'br-frame', src: st.url, title: `Preview of ${st.url}`, sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals', referrerpolicy: 'no-referrer' });
    body.append(h('div', { class: 'p-bar br-bar' }, home, input, ...modeChips(), iconBtn('refresh', 'Reload', () => (frame.src = st.url), 'sm'), ext), sugg, h('div', { class: 'br-view' + (st.device ? ' device' : '') }, frame));
    return;
  }
  // The Windows app: a <webview> kept per conversation, so switching tabs does not lose the page.
  const back = iconBtn('arrow-left', 'Back', () => st.view?.canGoBack() && st.view.goBack(), 'sm');
  const fwd = iconBtn('arrow-right', 'Forward', () => st.view?.canGoForward() && st.view.goForward(), 'sm');
  const reload = iconBtn('refresh', 'Reload', () => (st.loading ? st.view?.stop() : st.view?.reload()), 'sm');
  const bar = h('div', { class: 'p-bar br-bar' }, back, fwd, reload, input, ...modeChips(), home, ext);
  const err = h('div', { class: 'br-err', hidden: true });
  const loading = h('div', { class: 'br-load', hidden: true });
  let wv = st.view;
  if (!wv) {
    wv = h('webview', { class: 'br-frame', src: st.url, partition: st.incog ? `orbix-incognito-${st.incogN || 1}` : 'persist:orbix-browser', allowpopups: '', useragent: st.device ? PHONE.ua : null });
    st.view = wv;
  }
  const sync = () => {
    if (!wv.isConnected) return;
    try {
      back.disabled = !wv.canGoBack();
      fwd.disabled = !wv.canGoForward();
    } catch {
      back.disabled = fwd.disabled = true;
    }
    replace(reload, icon(st.loading ? 'x' : 'refresh', 14));
    reload.title = st.loading ? 'Stop' : 'Reload';
    loading.hidden = !st.loading;
  };
  // Listeners are added once per view; they update whatever bar is drawn now (bars are redrawn, views are kept).
  if (!wv.dataset.wired) {
    wv.dataset.wired = '1';
    const now = () => body.querySelector('.br-url');
    const nav = (e) => {
      if (e.isMainFrame === false) return;
      st.url = e.url;
      const box = now();
      if (box && document.activeElement !== box) box.value = e.url;
      if (!st.incog) rememberVisit(e.url);
      st.sync?.();
    };
    wv.addEventListener('did-navigate', nav);
    wv.addEventListener('did-navigate-in-page', nav);
    wv.addEventListener('did-start-loading', () => ((st.loading = true), (st.error = ''), st.sync?.()));
    wv.addEventListener('did-stop-loading', () => ((st.loading = false), st.sync?.()));
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3: the load was replaced by another one
      st.error = `${e.errorDescription || 'The page did not load'} (${e.validatedURL || st.url})`;
      st.sync?.();
    });
  }
  st.sync = () => {
    sync();
    err.hidden = !st.error;
    err.textContent = st.error || '';
  };
  body.append(bar, sugg, loading, err, h('div', { class: 'br-view' + (st.device ? ' device' : '') }, wv));
  st.sync();
}

const emptyState = (ic, text) => h('div', { class: 'empty' }, h('span', { class: 'empty-ic', 'aria-hidden': 'true' }, icon(ic, 17)), text);

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
  const t = cur();
  if (t && (P.tab === 'changes' || !P.git)) loadGit();
  else if (t) loadGit(true);
}, 900);

async function loadGit(quiet) {
  const t = cur();
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
  body.append(h('div', { class: 'p-bar' }, icon(g?.repo ? 'branch' : 'folder', 14), h('span', { class: 'grow ell mono' }, g?.repo ? `${g.branch}${g.upstream ? ' → ' + g.upstream : ''}${g.ahead ? ` ↑${g.ahead}` : ''}${g.behind ? ` ↓${g.behind}` : ''}` : baseName(t.workspace)), iconBtn('refresh', 'Refresh', () => loadGit(), 'sm')));
  if (P.busy && !g) return body.append(skeleton(6, 'pad'));
  if (P.gitErr) return body.append(errorState(P.gitErr, { title: 'Couldn’t read the changes.', retry: () => loadGit() }));
  if (!g) return loadGit();
  if (g.gitMissing) return body.append(emptyState('branch', 'Git is not installed, so changes cannot be shown.'));
  if (!g.repo) {
    const init = btn('Initialize Git', async () => {
      try {
        await api.post('/api/git/init', { ws: t.workspace });
        toast(`Initialized a Git repository in ${baseName(t.workspace)}`, 'ok', 2400);
        emit('git:init', t.workspace);
        await loadGit();
      } catch (e) {
        toast(e.message, 'error');
      }
    }, 'sm');
    return body.append(h('div', { class: 'empty' }, h('span', { class: 'empty-ic', 'aria-hidden': 'true' }, icon('branch', 17)), h('b', null, 'Not a Git repository'), h('span', null, 'Initialize Git to track the agent’s changes here, review them and undo them.'), init));
  }
  if (!g.files.length) return body.append(emptyState('check', 'No changes yet.'));
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
    if (cur() === t) await loadGit(true);
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
    if (P.tab === 'changes' && !P.diff && cur() === t) draw();
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
    const { diff } = await api.get(`/api/git/diff?ws=${encodeURIComponent(t.workspace)}&file=${encodeURIComponent(f.path)}${f.untracked ? '&untracked=1' : ''}${S.ui.diffIgnoreWs === true ? '&w=1' : ''}`);
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

/** Tasks: the agent's task list, then the helper agents it started for research. */
// ---------------------------------------------------------------- Context
/**
 * What the conversation holds: the session, provider and model, the context window and
 * how full it is, tokens by kind, messages, cost, when it started and was last active, and the system prompt the
 * next turn sends (ORBIX's own agent; an agent CLI keeps its own).
 */
let ctxEl = null;
function drawContext(t) {
  ctxEl = { grid: h('dl', { class: 'ctx-grid' }), prompt: h('div', { class: 'ctx-prompt' }, skeleton(6, 'pad')), t };
  const compact = btn('Compact now', () => sendPrompt(t, '/compact').catch((e) => toast(e.message, 'error')), 'sm');
  const copy = btn('Copy system prompt', () => copyText(ctxEl?.promptText || '').then(() => toast('Copied', 'ok', 1200)), 'sm');
  ctxEl.compact = compact;
  ctxEl.copy = copy;
  body.append(h('div', { class: 'p-scroll ctx-page' },
    ctxEl.grid,
    h('div', { class: 'ctx-acts' }, compact, copy),
    h('h4', { class: 'ctx-h' }, 'System prompt'),
    ctxEl.prompt));
  fillContext(t);
  rpc(t.id, { type: 'get_system_prompt' }).then((r) => {
    if (!ctxEl || ctxEl.t !== t || !ctxEl.prompt.isConnected) return;
    const text = r?.data?.text || '';
    ctxEl.promptText = text;
    ctxEl.copy.hidden = !text;
    ctxEl.prompt.replaceChildren(text ? h('pre', { class: 'ctx-sys' }, text) : h('p', { class: 'muted small' }, `${r?.data?.owner || 'This agent'} builds its own system prompt; ORBIX does not see it.`));
  }, (e) => ctxEl?.prompt.isConnected && ctxEl.prompt.replaceChildren(errorState(e.message, { title: 'Couldn’t read the system prompt.' })));
}

async function fillContext(t) {
  if (!ctxEl || ctxEl.t !== t || !ctxEl.grid.isConnected) return;
  let st = t.stats || {};
  try {
    st = (await rpc(t.id, { type: 'get_session_stats' }))?.data || st;
  } catch {}
  if (!ctxEl?.grid.isConnected) return;
  const msgs = t.messages || [];
  const cu = st.contextUsage || t.stats?.contextUsage;
  const tk = st.tokens || {};
  const m = t.model;
  const pv = S.engine?.providers?.find((p) => p.id === m?.provider)?.name || m?.provider || '';
  const times = msgs.map((x) => x.doneAt || x.timestamp).filter(Boolean);
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  const n = (v) => (Number.isFinite(v) ? v.toLocaleString() : '—');
  const reasoning = msgs.reduce((a, x) => a + (x.role === 'assistant' ? x.usage?.reasoning || 0 : 0), 0);
  const rows = [
    ['Session', t.name],
    ['Messages', n(st.totalMessages ?? msgs.length)],
    ['Provider', pv || '—'],
    ['Model', m ? m.name || m.id : '—'],
    ['Context limit', cu ? n(cu.contextWindow) : '—'],
    ['In context now', cu ? `${n(cu.tokens)}${cu.estimated ? ' (estimated)' : ''}` : '—'],
    ['Usage', cu ? `${cu.percent < 1 ? cu.percent.toFixed(1) : Math.round(cu.percent)}%` : '—'],
    ['Total tokens', n(tk.total)],
    ['Input tokens', n(tk.input)],
    ['Output tokens', n(tk.output)],
    reasoning ? ['Reasoning tokens', n(reasoning)] : null,
    ['Cache tokens (read / write)', `${n(tk.cacheRead)} / ${n(tk.cacheWrite)}`],
    ['Your messages', n(st.userMessages ?? msgs.filter((x) => x.role === 'user').length)],
    ['Replies', n(st.assistantMessages ?? msgs.filter((x) => x.role === 'assistant').length)],
    st.toolCalls != null ? ['Tool calls', n(st.toolCalls)] : null,
    ['Total cost', st.cost != null ? fmtCost(st.cost) : 'Not reported'],
    ['Started', when(times[0])],
    ['Last activity', when(times[times.length - 1])],
  ].filter(Boolean);
  ctxEl.grid.replaceChildren(...rows.map(([k, v]) => h('div', { class: 'ctx-cell' }, h('dt', null, k), h('dd', { class: 'num' }, v))));
  if (cu) {
    const bar = h('div', { class: 'ctx-bar' + (cu.percent > 90 ? ' crit' : cu.percent > 70 ? ' hot' : '') }, h('i'));
    bar.firstChild.style.setProperty('--p', `${Math.min(100, cu.percent).toFixed(1)}%`);
    ctxEl.grid.append(h('div', { class: 'ctx-cell wide' }, h('dt', null, `Context window · ${fmtTokens(cu.tokens)} of ${fmtTokens(cu.contextWindow)}`), bar));
  }
  ctxEl.compact.disabled = !!t.streaming || !msgs.length;
  ctxEl.compact.title = t.streaming ? 'Wait until the agent is done' : 'Summarize older turns now to free the context';
}

function drawTodos(t) {
  const total = (t.todos || []).flatMap((p) => p.tasks || []).length;
  const helpers = [...(t.subagents?.values() || [])].sort((a, b) => (b.progress?.durationMs ? 0 : 1) - (a.progress?.durationMs ? 0 : 1));
  if (!total && !helpers.length) return body.append(emptyState('list', 'The agent’s task list, and the helper agents it starts, appear here while it works.'));
  body.append(h('div', { class: 'p-scroll pad' },
    total ? todoList(t.todos) : null,
    helpers.length ? h('section', { class: 'p-sec agents' }, h('h4', { class: 'p-sec-h' }, 'Helper agents', h('span', { class: 'num' }, String(helpers.length))), helpers.map(agentRow)) : null));
}
