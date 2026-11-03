// ORBIX front-end bootstrap: layout, sidebar, tabs, keyboard, and routing of events to views.
import { $, h, icon, iconBtn, replace, toast, timeAgo, baseName, logo, lsGet, lsSet, kbd } from './dom.js';
import { api, rpc, connectEvents } from './api.js';
import { S, Tab, on, emit, activeTab, loadEnv, loadSessions, openTab, closeTab, setActive, routeEvent, onHello, onProcs, attach, savePrefs, groupSessions, tabForSession, ompInstalled, engineReady, renameSession } from './store.js';
import { TabView, sessionMenu, copyConversation } from './session.js';
import { drawHome, setHomeProject } from './home.js';
import { openCleanup, confirmDeleteConversation } from './cleanup.js';
import { openDiagnostics } from './diagnostics.js';
import { initNotify } from './notify.js';
import { initStatusBar } from './chrome.js';
import { openHelp } from './help.js';
import { mountPanel, showTab } from './panels.js';
import { folderPicker, shortcutsDialog, palette, syncExtDialogs, confirmDialog, promptDialog } from './dialogs.js';
import { openSettings as settingsDialog } from './settings.js';
import { onAuthEvent, onAuthHello } from './providers.js';

const views = new Map();
const sideEl = $('#sidebar');
const topEl = $('#topbar');
const sessEl = $('#session');
const homeEl = $('#welcome');
const appEl = $('#app');
let searchTerm = '';
const collapsed = new Set(lsGet('collapsed', []));

// In narrow windows the sidebar and side panel float over the content; there they open on demand and are not saved.
const narrowSide = matchMedia('(max-width: 760px)');
const narrowPanel = matchMedia('(max-width: 1100px)');
const overlay = { side: false, panel: false };

function applyPrefs() {
  const u = S.ui;
  const root = document.documentElement;
  const dark = u.theme === 'dark' || (u.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  lsSet('look', { theme: root.dataset.theme });
  root.style.setProperty('--fs', (u.fontSize || 14) + 'px');
  root.style.setProperty('--side-w', Math.min(400, u.sidebarW || 264) + 'px');
  root.style.setProperty('--panel-w', (u.panelW || 380) + 'px');
  const side = narrowSide.matches ? overlay.side : u.sidebar !== false;
  const panel = !!activeTab() && (narrowPanel.matches ? overlay.panel : u.rightPanel !== false);
  appEl.classList.toggle('no-side', !side);
  appEl.classList.toggle('no-panel', !panel);
  appEl.classList.toggle('overlay-side', side && narrowSide.matches);
  appEl.classList.toggle('overlay-panel', panel && narrowPanel.matches);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
for (const mq of [narrowSide, narrowPanel]) mq.addEventListener('change', () => ((overlay.side = overlay.panel = false), applyPrefs(), drawTop()));

const sideShown = () => !appEl.classList.contains('no-side');
const panelShown = () => !appEl.classList.contains('no-panel');
function toggleSidebar() {
  if (narrowSide.matches) (overlay.side = !overlay.side), applyPrefs(), drawTop();
  else savePrefs({ sidebar: S.ui.sidebar === false });
}
function togglePanel() {
  if (!activeTab()) return;
  if (narrowPanel.matches) (overlay.panel = !overlay.panel), applyPrefs(), drawTop();
  else savePrefs({ rightPanel: S.ui.rightPanel === false });
}
on('panel:open', () => {
  if (narrowPanel.matches && !overlay.panel) (overlay.panel = true), applyPrefs(), drawTop();
});
// A click outside a floating sidebar or panel closes it.
appEl.addEventListener('mousedown', (e) => {
  if (overlay.side && narrowSide.matches && !sideEl.contains(e.target) && !e.target.closest('.tb-side')) (overlay.side = false), applyPrefs(), drawTop();
  if (overlay.panel && narrowPanel.matches && !$('#panel').contains(e.target) && !e.target.closest('.tb-panel')) (overlay.panel = false), applyPrefs(), drawTop();
});

function resizer(id, varName, key, min, max, fromRight) {
  const el = $(id);
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el.classList.add('drag');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = fromRight ? innerWidth - ev.clientX : ev.clientX;
      const v = Math.round(Math.max(min, Math.min(max, w)));
      document.documentElement.style.setProperty(varName, v + 'px');
      S.ui[key] = v;
    };
    const up = () => {
      el.classList.remove('drag');
      document.body.classList.remove('resizing');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      savePrefs({ [key]: S.ui[key] });
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}
resizer('#rs-side', '--side-w', 'sidebarW', 220, 400, false);
resizer('#rs-panel', '--panel-w', 'panelW', 280, 720, true);

const dotCls = (t) => 'dot' + (t.dead ? ' dead' : t.streaming ? ' run' : t.unread ? ' unread' : ' open');

function drawSidebar() {
  const groups = groupSessions();
  const term = searchTerm.toLowerCase().trim();
  // The sidebar is rebuilt on every change; keep the search box focused (with its caret) and the list scroll.
  const typing = document.activeElement?.matches?.('.side-search input') ? document.activeElement.selectionStart : -1;
  const scroll = sideEl.querySelector('.side-scroll')?.scrollTop || 0;
  const search = h('input', { type: 'search', placeholder: 'Filter conversations', value: searchTerm, 'aria-label': 'Filter conversations', spellcheck: 'false', oninput: (e) => ((searchTerm = e.target.value), drawSidebar()), onkeydown: (e) => e.key === 'Escape' && searchTerm && (e.stopPropagation(), (searchTerm = ''), drawSidebar()) });
  const projects = groups.map((g) => {
    const sess = g.sessions.filter((s) => !term || `${s.title} ${g.name} ${s.preview || ''}`.toLowerCase().includes(term));
    if (term && !sess.length && !g.name.toLowerCase().includes(term)) return null;
    const open = !!term || !collapsed.has(g.key);
    const shown = open ? sess.slice(0, term ? 50 : 8) : [];
    const toggle = () => {
      collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key);
      lsSet('collapsed', [...collapsed]);
      drawSidebar();
    };
    return h('div', { class: 'proj' },
      h('div', { class: 'proj-head' },
        h('button', { class: 'proj-btn', type: 'button', title: g.path, 'aria-expanded': String(open), onclick: toggle }, icon(open ? 'chevron-down' : 'chevron-right', 12, 'chev'), h('span', { class: 'ell' }, g.name)),
        h('span', { class: 'row-acts' },
          iconBtn('plus', `New session in ${g.name}`, () => newSession(g.path), 'sm'),
          g.saved ? iconBtn('x', 'Remove from the list (files stay)', async () => {
            try {
              S.workspaces = (await api.post('/api/workspaces/remove', { id: g.id })).workspaces;
              drawSidebar();
            } catch (e) {
              toast(e.message, 'error');
            }
          }, 'sm') : null)),
      shown.map((s) => {
        const tab = tabForSession(s);
        const cur = !!tab && tab.id === S.active;
        return h('div', { class: 's-row' + (cur ? ' cur' : '') },
          h('button', { class: 's-btn', type: 'button', title: s.preview || s.title, 'aria-current': cur ? 'page' : null, onclick: () => openSession(s) }, tab ? h('span', { class: dotCls(tab) }) : null, h('span', { class: 'ell grow' }, s.title), h('span', { class: 's-when' }, timeAgo(s.mtime))),
          h('span', { class: 'row-acts' }, iconBtn('trash', 'Delete conversation', () => confirmDeleteConversation(s), 'sm')));
      }),
      open && !term && sess.length > shown.length ? h('button', { class: 's-more', type: 'button', onclick: () => ((searchTerm = g.name), drawSidebar(), sideEl.querySelector('.side-search input')?.focus()) }, `${sess.length - shown.length} more`) : null);
  }).filter(Boolean);
  replace(
    sideEl,
    h('div', { class: 'side-top' }, h('div', { class: 'brand' }, logo(22), h('span', { class: 'wordmark' }, 'ORBIX'))),
    h('button', { class: 'side-new' + (S.active ? '' : ' cur'), type: 'button', title: 'New session (Ctrl+N)', onclick: () => newSession() }, icon('plus', 15), 'New session', kbd('Ctrl+N')),
    h('div', { class: 'side-search' }, icon('search', 14), search),
    h('div', { class: 'side-scroll' },
      h('div', { class: 'side-h' }, h('span', null, 'Projects'), iconBtn('folder-plus', 'Open a project folder', openFolder, 'sm')),
      projects.length ? projects : term ? h('div', { class: 'side-empty' }, 'No matching conversations.') : h('div', { class: 'side-empty' }, 'Projects and their conversations show here.', h('button', { class: 'btn sm', type: 'button', onclick: openFolder }, icon('folder-plus', 13), 'Open a folder'))),
    h('div', { class: 'side-foot' }, footStatus(), iconBtn('command', 'Commands (Ctrl+K)', () => palette(paletteItems)), iconBtn('cog', 'Settings (Ctrl+,)', () => settingsDialog())),
  );
  sideEl.querySelector('.side-scroll').scrollTop = scroll;
  if (typing >= 0) {
    search.focus({ preventScroll: true });
    search.setSelectionRange(typing, typing);
  }
}

/** Sidebar footer: whether the agent can work, and with which provider. */
function footStatus() {
  const ready = engineReady();
  const omp = ompInstalled();
  const names = (S.engine?.providers || []).filter((p) => p.configured).map((p) => p.name.replace(/ \(.*\)$/, ''));
  const text = ready ? names.join(', ') : omp ? 'OMP CLI only' : 'Set up a provider';
  return h('button', { class: 'foot-status', type: 'button', title: ready ? `AI providers: ${names.join(', ')}` : 'Add an API key or a local model', onclick: () => settingsDialog(ready ? 'start' : 'engine') }, h('span', { class: 'dot' + (ready || omp ? ' ok' : ' warn') }), h('span', { class: 'ell' }, text));
}

function toggleTheme() {
  savePrefs({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
}

/** Show the home composer (optionally for one project). Open tabs stay open. */
function newSession(project, opts) {
  setHomeProject(project, opts);
  if (narrowSide.matches) overlay.side = false;
  if (S.active) setActive(null);
  else showActive();
  queueMicrotask(() => homeEl.querySelector('textarea')?.focus());
}

async function openFolder() {
  const p = await folderPicker('');
  if (!p) return;
  try {
    const r = await api.post('/api/workspaces', { path: p });
    S.workspaces = r.workspaces;
    newSession(r.workspace.path);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openSession(s) {
  const existing = tabForSession(s);
  if (narrowSide.matches && overlay.side) (overlay.side = false), applyPrefs();
  if (existing) return setActive(existing.id);
  try {
    await openTab({ workspace: s.cwd, resume: s.path, title: s.title, engine: s.engine || 'omp' });
  } catch (e) {
    if (e.status !== 409) return toast(e.message, 'error', 8000);
    // Already open in a tab this window has not adopted yet: find that process and switch to it.
    const chain = new Set([s.path, ...(s.chain || [])]);
    const procs = await api.get('/api/procs').then((j) => j.procs).catch(() => []);
    const p = procs.find((x) => x.resume && chain.has(x.resume));
    if (p && !S.tabs.has(p.id)) await adoptRunning([p]);
    const tab = (p && S.tabs.get(p.id)) || tabForSession(s);
    toast('Already open in another tab', 'info', 2500);
    if (tab) setActive(tab.id);
  }
}

async function closeWithCheck(t) {
  if (t.streaming && !(await confirmDialog('Close session', 'The agent is still working. Stop it and close this session?', { ok: 'Stop and close', danger: true }))) return;
  closeTab(t.id);
}

async function renameTab(t) {
  const n = await promptDialog('Rename session', 'Name', t.name);
  if (n) renameSession(t, n).catch((e) => toast(e.message, 'error'));
}

const shownTabs = new Set(); // tabs already drawn once: only new ones play the enter animation
function drawTop() {
  const t = activeTab();
  const tabs = [...S.tabs.values()];
  const focusedTab = document.activeElement?.closest?.('.tab') ? document.activeElement.dataset.id : null;
  replace(
    topEl,
    iconBtn('panel-left', 'Sidebar (Ctrl+B)', toggleSidebar, 'tb-side' + (sideShown() ? ' on' : '')),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Open sessions' },
      tabs.map((x, i) => h('div', { class: 'tab' + (S.active === x.id ? ' cur' : '') + (shownTabs.has(x.id) ? '' : ' tab-in'), role: 'tab', dataset: { id: x.id }, 'aria-selected': String(S.active === x.id), tabindex: S.active === x.id || (!t && i === 0) ? '0' : '-1', title: `${x.name}\n${x.workspace}`, onclick: () => setActive(x.id), ondblclick: () => renameTab(x), onauxclick: (e) => e.button === 1 && closeWithCheck(x), onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), setActive(x.id));
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const all = [...topEl.querySelectorAll('.tab')];
          all[(all.indexOf(e.currentTarget) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]?.focus();
        } else if (e.key === 'Delete') closeWithCheck(x);
      } },
      h('span', { class: dotCls(x) }),
      h('span', { class: 'ell' }, x.name),
      h('button', { class: 'tab-x', type: 'button', tabindex: '-1', title: 'Close', 'aria-label': `Close ${x.name}`, onclick: (e) => (e.stopPropagation(), closeWithCheck(x)) }, icon('x', 12))))),
    iconBtn('plus', 'New session (Ctrl+N)', () => newSession(), S.active ? '' : 'on'),
    h('span', { class: 'grow' }),
    t ? iconBtn('more', 'Session actions', (e) => sessionMenu(t, e.currentTarget, { rename: () => renameTab(t), close: () => closeWithCheck(t) })) : null,
    t ? iconBtn('panel-right', 'Side panel (Ctrl+J)', togglePanel, 'tb-panel' + (panelShown() ? ' on' : '')) : null,
  );
  for (const x of tabs) shownTabs.add(x.id);
  for (const id of shownTabs) if (!S.tabs.has(id)) shownTabs.delete(id);
  topEl.querySelector('.tab.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusedTab) topEl.querySelector(`.tab[data-id="${CSS.escape(focusedTab)}"]`)?.focus({ preventScroll: true });
}

const homeHandlers = {
  openFolder,
  openSession,
  settings: (tab) => settingsDialog(tab),
  manage: openCleanup,
  diagnostics: openDiagnostics,
};
const drawWelcome = () => drawHome(homeEl, homeHandlers);

function viewFor(tab) {
  let v = views.get(tab.id);
  if (!v) {
    v = new TabView(tab);
    views.set(tab.id, v);
  }
  return v;
}

function showActive() {
  const t = activeTab();
  applyPrefs();
  drawTop();
  drawSidebar();
  for (const id of [...views.keys()]) if (!S.tabs.has(id)) views.delete(id);
  if (!t) {
    if (!sessEl.hidden) sessEl.firstChild?._view?.detach();
    sessEl.hidden = true;
    homeEl.hidden = false;
    drawWelcome();
    syncExtDialogs(null);
    return;
  }
  const v = viewFor(t);
  const cur = sessEl.firstChild;
  if (cur !== v.root || sessEl.hidden) {
    // Switching tabs keeps each conversation's scroll position.
    if (cur && !sessEl.hidden) cur._view?.detach();
    homeEl.hidden = true;
    sessEl.hidden = false;
    if (cur !== v.root) replace(sessEl, v.root);
    v.reattach();
  }
  v.updateComposer();
  v.updateApproval();
  syncExtDialogs(t);
  // A pending approval takes the keyboard (1 / 2 / Esc) unless a message is half typed.
  if (!t.dead && !document.querySelector('.scrim')) v.approvalEl && !v.composer.hasContent() ? v.approvalEl.focus({ preventScroll: true }) : v.focus();
}

on('tabs', () => {
  drawTop();
  drawSidebar();
});
on('active', showActive);
on('engine', () => {
  drawSidebar();
  if (!activeTab()) drawWelcome();
});
on('sessions', () => {
  drawSidebar();
  if (!activeTab()) drawWelcome();
});
on('prefs', (patch = {}) => {
  applyPrefs();
  drawSidebar();
  drawTop();
  const t = activeTab();
  if (t && 'showThinking' in patch) views.get(t.id)?.renderAll();
});
const viewOf = (tab) => views.get(tab.id);
on('tab:messages', (tab, d) => {
  const v = viewOf(tab);
  if (!v) return;
  if (d.type === 'reset') v.renderAll();
  else if (d.type === 'remove') v.removeMsg(d.msg);
  else v.appendMsg(d.msg);
  if (d.msg?.role === 'user') drawTop();
});
on('tab:live', (tab) => viewOf(tab)?.renderLive());
on('tab:tool', (tab, id) => viewOf(tab)?.updateTool(id));
// The sidebar logo's satellite orbits while any session is working.
const syncBusy = () => document.documentElement.classList.toggle('agent-busy', [...S.tabs.values()].some((t) => t.streaming && !t.dead));
on('tab:state', (tab) => (viewOf(tab)?.updateComposer(), syncBusy()));
on('tabs', syncBusy);
on('tab:status', (tab) => {
  const v = viewOf(tab);
  v?.updateComposer();
  if (tab.dead && v && !v.deadShown) v.showDead();
  drawTop();
  drawSidebar();
});
on('tab:editor', (tab) => viewOf(tab)?.setText(tab.draft));
on('tab:dialog', (tab) => {
  viewOf(tab)?.updateApproval();
  if (tab === activeTab()) syncExtDialogs(tab);
});
on('insert', (text) => {
  const t = activeTab();
  const v = t && viewOf(t);
  if (v) {
    const cur = v.composer.value;
    v.setText(cur + (cur && !/\s$/.test(cur) ? ' ' : '') + text);
    v.focus();
  }
});
on('settings', (tab) => settingsDialog(tab));
on('home', (project) => newSession(project));

function paletteItems() {
  const t = activeTab();
  const dark = document.documentElement.dataset.theme === 'dark';
  const items = [
    { group: 'General', icon: 'plus', label: 'New session', key: 'Ctrl+N', run: () => newSession() },
    { group: 'General', icon: 'plus', label: 'New session without saving it', run: () => newSession(undefined, { ephemeral: true }) },
    { group: 'General', icon: 'folder-plus', label: 'Open project folder…', run: openFolder },
    { group: 'General', icon: 'cog', label: 'Settings', key: 'Ctrl+,', run: () => settingsDialog() },
    { group: 'General', icon: 'key', label: 'AI providers', run: () => settingsDialog('engine') },
    ...(ompInstalled() ? [{ group: 'General', icon: 'terminal', label: 'OMP CLI settings', run: () => settingsDialog('omp') }] : []),
    { group: 'General', icon: 'trash', label: 'Manage conversations…', run: openCleanup },
    { group: 'General', icon: 'activity', label: 'Diagnostics', run: openDiagnostics },
    { group: 'General', icon: 'compass', label: 'How ORBIX works', run: openHelp },
    { group: 'General', icon: 'keyboard', label: 'Keyboard shortcuts', run: shortcutsDialog },
    { group: 'View', icon: dark ? 'sun' : 'moon', label: dark ? 'Light theme' : 'Dark theme', run: toggleTheme },
    { group: 'View', icon: 'panel-left', label: 'Toggle sidebar', key: 'Ctrl+B', run: toggleSidebar },
  ];
  if (t) {
    items.push({ group: 'View', icon: 'panel-right', label: 'Toggle side panel', key: 'Ctrl+J', run: togglePanel });
    for (const [k, l, ic] of [['files', 'Files', 'folder'], ['changes', 'Changes', 'branch'], ['todos', 'Plan', 'list'], ['agents', 'Agents', 'users'], ['console', 'Console', 'terminal']]) items.push({ group: 'View', icon: ic, label: `Show ${l}`, run: () => showTab(k) });
    items.push({ group: 'Session', icon: 'pencil', label: 'Rename session…', run: () => renameTab(t) }, { group: 'Session', icon: 'copy', label: 'Copy conversation as Markdown', run: () => copyConversation(t) }, { group: 'Session', icon: 'x', label: 'Close session', run: () => closeWithCheck(t) });
    for (const c of t.commands) items.push({ group: 'Slash commands', icon: 'command', label: `/${c.name}`, hint: c.description, run: () => emit('insert', `/${c.name} `) });
  }
  for (const s of S.sessions.slice(0, 50)) items.push({ group: 'Conversations', icon: 'message', label: s.title, hint: baseName(s.cwdDisplay || s.cwd), run: () => openSession(s) });
  return items;
}

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'n') return e.preventDefault(), newSession();
    if (k === 'k') return e.preventDefault(), document.querySelector('.palette') || palette(paletteItems);
    if (k === ',') return e.preventDefault(), settingsDialog();
    if (k === 'b') return e.preventDefault(), toggleSidebar();
    if (k === 'j') return e.preventDefault(), togglePanel();
    if (k === 'l') return e.preventDefault(), (activeTab() ? viewOf(activeTab())?.focus() : homeEl.querySelector('textarea')?.focus());
  }
  // Esc anywhere outside a text field stops the agent (fields, menus and dialogs handle Esc themselves first).
  if (e.key === 'Escape' && !mod && !e.defaultPrevented && !e.target.closest?.('input, textarea, select, .scrim, .menu')) {
    const t = activeTab();
    const v = t && viewOf(t);
    if (v && (t.streaming || v.approvalDlg)) return e.preventDefault(), v.onEscape();
  }
  if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
    const t = [...S.tabs.values()][+e.key - 1];
    if (t) (e.preventDefault(), setActive(t.id));
  }
});

const banner = $('#banner');
const setBanner = (msg) => {
  banner.hidden = !msg;
  banner.textContent = msg || '';
};

async function adoptRunning(procs) {
  for (const p of procs) {
    if (S.tabs.has(p.id)) continue;
    const tab = new Tab(p.id, p.workspace, { resume: p.resume, engine: p.engine });
    S.tabs.set(p.id, tab);
    try {
      const c = await rpc(p.id, { type: 'get_available_commands' });
      tab.commands = c.data?.commands || [];
      await attach(tab);
    } catch {}
    tab.ready = true;
    for (const ev of tab.buffer.splice(0)) routeEvent(p.id, ev);
  }
  if (!S.active && S.tabs.size) setActive([...S.tabs.keys()][0]);
  else emit('tabs');
}

async function boot() {
  try {
    await loadEnv();
  } catch (e) {
    setBanner(e.message);
    return;
  }
  applyPrefs();
  drawSidebar();
  drawTop();
  drawWelcome();
  mountPanel($('#panel'));
  initNotify();
  initStatusBar();
  loadSessions();
  connectEvents({
    onEvent: routeEvent,
    onGlobal: async (g) => {
      if (g.g === 'hello') {
        onAuthHello(g.auth);
        await adoptRunning(g.procs);
        onHello(g.procs);
      } else if (g.g === 'procs') onProcs(g.procs);
      else if (g.g === 'auth') onAuthEvent(g.e);
    },
    onOpen: () => {
      S.connected = true;
      setBanner('');
      emit('env');
    },
    onClose: () => {
      S.connected = false;
      setBanner('Reconnecting to the ORBIX server…');
      emit('env');
    },
  });
  setInterval(() => document.hidden || loadSessions(), 30000);
}
boot();
