// ORBIX front-end bootstrap: layout, sidebar, tabs, keyboard, and routing of events to views.
import './desktop.js';
import { $, h, icon, iconBtn, replace, toast, timeAgo, baseName, logo, lsGet, lsSet, kbd, copyText } from './dom.js';
import { api, rpc, connectEvents } from './api.js';
import { S, Tab, on, emit, activeTab, loadEnv, loadSessions, openTab, closeTab, setActive, routeEvent, onHello, onProcs, attach, savePrefs, groupSessions, unlistedTabs, tabForSession, engineReady, renameSession, keyPath } from './store.js';
import { TabView, sessionMenu, copyConversation } from './session.js';
import { drawHome, setHomeProject } from './home.js';
import { openCleanup, confirmDeleteConversation } from './cleanup.js';
import { openDiagnostics } from './diagnostics.js';
import { initNotify } from './notify.js';
import { initStatusBar } from './chrome.js';
import { openHelp } from './help.js';
import { mountPanel, showTab, viewFile } from './panels.js';
import { folderPicker, shortcutsDialog, palette, syncExtDialogs, confirmDialog, promptDialog, popMenu, isApproval } from './dialogs.js';
import { onBoard, boardState } from './review.js';
import { openSettings as settingsDialog } from './settings.js';
import { barHandlers, toggleZen, toggleWide, zenOn } from './workbench.js';
import { initInterface } from './interface.js';
import { sideUpdate } from './updates.js';

const views = new Map();
const sideEl = $('#sidebar');
const topEl = $('#topbar');
const sessEl = $('#session');
const homeEl = $('#welcome');
const appEl = $('#app');
let searchTerm = '';
const collapsed = new Set(lsGet('collapsed', []));
// Projects whose whole list is shown (by default a project shows its newest conversations only).
const expanded = new Set(lsGet('expanded', []));
const SHOWN = 8;

// In narrow windows the sidebar and side panel float over the content; there they open on demand and are not saved.
const narrowSide = matchMedia('(max-width: 760px)');
const narrowPanel = matchMedia('(max-width: 1100px)');
const overlay = { side: false, panel: false };

// Every theme belongs to a mode (dark or light); the mode drives color-scheme and anything that only needs to know which.
const THEMES = { dark: 'dark', light: 'light', midnight: 'dark', frost: 'light' };
/** The Windows app's interface size: a chosen factor, or on Auto one that fits the screen (larger on wide screens). */
export function interfaceScale(v, screenWidth = window.orbixDesktop?.screenWidth || 0) {
  if (typeof v === 'number' && v >= 0.5 && v <= 2) return v;
  return screenWidth >= 3000 ? 1.25 : screenWidth >= 2300 ? 1.15 : 1;
}
// The sidebar can be dragged between these widths (double-click the edge to reset).
const SIDE_MIN = 220, SIDE_MAX = 440, SIDE_W = 264;

function applyPrefs() {
  const u = S.ui;
  const root = document.documentElement;
  window.orbixDesktop?.setZoom(interfaceScale(u.uiScale));
  const name = THEMES[u.theme] ? u.theme : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; // 'system' or unknown
  root.dataset.theme = name;
  root.dataset.mode = THEMES[name];
  lsSet('look', { theme: name });
  root.style.setProperty('--fs', (u.fontSize || 14) + 'px');
  root.classList.toggle('compact', u.density === 'compact');
  root.dataset.density = u.density === 'compact' ? 'compact' : 'comfortable';
  root.style.setProperty('--side-w', Math.min(SIDE_MAX, Math.max(SIDE_MIN, u.sidebarW || 264)) + 'px');
  root.style.setProperty('--panel-w', (u.panelW || 380) + 'px');
  const side = narrowSide.matches ? overlay.side : u.sidebar !== false;
  const panel = !!activeTab() && (narrowPanel.matches ? overlay.panel : u.rightPanel !== false);
  appEl.classList.toggle('no-side', !side);
  // Rail: the sidebar folded to its icons. Never in overlay mode, where the sidebar is a drawer.
  appEl.classList.toggle('rail', side && !narrowSide.matches && u.rail === true);
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

function resizer(id, varName, key, min, max, fromRight, reset) {
  const el = $(id);
  if (reset) el.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty(varName, reset + 'px');
    savePrefs({ [key]: reset });
  });
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
resizer('#rs-side', '--side-w', 'sidebarW', SIDE_MIN, SIDE_MAX, false, SIDE_W);
resizer('#rs-panel', '--panel-w', 'panelW', 280, 720, true, 380);

const dotCls = (t) => 'dot' + (t.dead ? ' dead' : t.streaming ? ' run' : t.unread ? ' unread' : ' open');
const fmtSecs = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);

// Pinned conversations, by session file, saved with the other UI preferences.
const pinned = () => (Array.isArray(S.ui.pinned) ? S.ui.pinned : []);
function togglePin(s) {
  const list = pinned();
  savePrefs({ pinned: list.includes(s.path) ? list.filter((p) => p !== s.path) : [s.path, ...list].slice(0, 20) });
}

/** Rename a conversation, open or not: an open one through its session, a saved one in its file. */
async function renameConversation(s) {
  const tab = tabForSession(s);
  if (tab) return renameTab(tab);
  const n = (await promptDialog('Rename conversation', 'Name', s.title))?.trim();
  if (!n || n === s.title) return;
  try {
    await api.post('/api/sessions/rename', { path: s.path, title: n });
    await loadSessions();
    drawSidebar();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function rowMenu(s, anchor) {
  const tab = tabForSession(s);
  const isPinned = pinned().includes(s.path);
  popMenu(anchor, [
    { header: s.title },
    { label: tab ? 'Show' : 'Open', run: () => openSession(s) },
    { label: isPinned ? 'Unpin' : 'Pin to the top', hint: 'P', run: () => togglePin(s) },
    { label: 'Rename…', hint: 'F2', run: () => renameConversation(s) },
    { label: 'New session in this project', run: () => newSession(s.cwdDisplay || s.cwd) },
    { label: 'Show folder in Explorer', run: () => api.post('/api/fs/reveal', { path: s.cwdDisplay || s.cwd }).catch((e) => toast(e.message, 'error')) },
    '-',
    { label: 'Delete conversation…', danger: true, hint: 'Del', run: () => confirmDeleteConversation(s) },
  ].filter(Boolean), { minWidth: 240 });
}

/** One saved conversation in the sidebar. `where` shows its project (in Pinned, where rows from many projects mix). */
/** Keys on a focused conversation row: F2 renames, P pins or unpins, Delete asks to delete, Shift+F10 opens its menu. */
function rowKeys(s, e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'F2') return e.preventDefault(), renameConversation(s);
  if (e.key === 'Delete') return e.preventDefault(), confirmDeleteConversation(s);
  if (e.key.toLowerCase() === 'p' && !e.shiftKey) return e.preventDefault(), togglePin(s);
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') return e.preventDefault(), rowMenu(s, e.currentTarget);
}

function sessionRow(s, where) {
  const tab = tabForSession(s);
  const cur = !!tab && tab.id === S.active;
  const more = iconBtn('more', 'More', (e) => rowMenu(s, e.currentTarget), 'sm');
  const tip = [s.title, where, s.branch ? `Branch ${s.branch}` : '', !where && s.preview && s.preview !== s.title ? s.preview : ''].filter(Boolean).join('\n');
  return h('div', { class: 's-row' + (cur ? ' cur' : '') + (tab?.streaming ? ' live' : '') },
    h('button', { class: 's-btn', type: 'button', title: tip, 'aria-current': cur ? 'page' : null, onclick: () => openSession(s), ondblclick: (e) => (e.preventDefault(), renameConversation(s)), onkeydown: (e) => rowKeys(s, e), oncontextmenu: (e) => (e.preventDefault(), rowMenu(s, e.currentTarget)) },
      tab ? h('span', { class: dotCls(tab) }) : null,
      s.branch ? icon('branch', 12, 's-br') : null,
      h('span', { class: 'ell grow' }, s.title),
      where ? h('span', { class: 's-where ell' }, where) : h('span', { class: 's-when' }, timeAgo(s.mtime))),
    h('span', { class: 'row-acts' }, more));
}

/** A project's menu (its ⋯ button or a right-click on its name). */
function projectMenu(g, anchor) {
  const all = groupSessions();
  popMenu(anchor, [
    { header: g.name },
    { label: 'New session here', run: () => newSession(g.path) },
    { label: 'Show folder in Explorer', run: () => api.post('/api/fs/reveal', { path: g.path }).catch((e) => toast(e.message, 'error')) },
    { label: 'Copy folder path', run: () => copyText(g.path) },
    '-',
    { label: 'Fold the other projects', run: () => {
      for (const x of all) if (x.key !== g.key) collapsed.add(x.key);
      collapsed.delete(g.key);
      lsSet('collapsed', [...collapsed]);
      drawSidebar();
    } },
    { label: 'Unfold all projects', run: () => {
      collapsed.clear();
      lsSet('collapsed', []);
      drawSidebar();
    } },
    g.saved ? '-' : null,
    g.saved ? { label: 'Remove from the list', hint: 'files kept', run: async () => {
      try {
        S.workspaces = (await api.post('/api/workspaces/remove', { id: g.id })).workspaces;
        drawSidebar();
      } catch (e) {
        toast(e.message, 'error');
      }
    } } : null,
  ].filter(Boolean), { minWidth: 240 });
}

/** Pinned conversations, above the projects. */
function pinnedList(term) {
  const by = new Map(S.sessions.map((x) => [x.path, x]));
  const list = pinned().map((p) => by.get(p)).filter(Boolean).filter((x) => !term || `${x.title} ${x.preview || ''}`.toLowerCase().includes(term));
  if (!list.length) return null;
  return h('div', { class: 'pin-sec' }, h('div', { class: 'side-h' }, h('span', null, 'Pinned')), list.map((x) => sessionRow(x, baseName(x.cwdDisplay || x.cwd))));
}

/** Arrow keys move between the rows of the sidebar list; Home and End go to the ends. */
function listKeys(e) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey) return;
  const rows = [...sideEl.querySelectorAll('.side-scroll .run-row, .side-scroll .proj-btn, .side-scroll .s-btn')].filter((x) => x.getClientRects().length);
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  rows[n].focus();
}

/**
 * What the sidebar shows, as one string. Status events arrive many times a minute while agents work; rebuilding on
 * each one dropped the hover, the keyboard focus and any open row menu, so it is rebuilt only when this changes.
 */
let sideSig = '';
function sidebarSig() {
  return JSON.stringify([
    searchTerm, [...collapsed], [...expanded], pinned(), S.active, S.ui.rail === true, Math.floor(Date.now() / 60000),
    S.sessions.map((s) => [s.path, s.mtime, s.title]),
    [...S.tabs.values()].map((t) => [t.id, t.name, t.workspace, !!t.streaming, !!t.dead, !!t.unread, t.dialogs.some(isApproval), t.resume || '', t.state?.sessionId || '', t.worktree?.branch || '', t.worktree?.state || '']),
    S.workspaces.map((w) => [w.id, w.path, w.name]),
    (S.engine?.providers || []).filter((p) => p.configured).map((p) => p.name),
    S.update ? [S.update.state, S.update.version, S.update.percent] : null,
  ]);
}

function drawSidebar() {
  const sig = sidebarSig();
  if (sig === sideSig && sideEl.querySelector('.side-scroll')) return;
  sideSig = sig;
  const groups = groupSessions();
  const term = searchTerm.toLowerCase().trim();
  // The sidebar is rebuilt on every change; keep the search box focused (with its caret) and the list scroll.
  const typing = document.activeElement?.matches?.('.side-search input') ? document.activeElement.selectionStart : -1;
  const scroll = sideEl.querySelector('.side-scroll')?.scrollTop || 0;
  const search = h('input', { type: 'search', placeholder: 'Filter conversations', value: searchTerm, 'aria-label': 'Filter conversations', spellcheck: 'false', oninput: (e) => ((searchTerm = e.target.value), drawSidebar()), onkeydown: (e) => {
    if (e.key === 'Escape' && searchTerm) return e.stopPropagation(), (searchTerm = ''), drawSidebar();
    if (e.key === 'Enter') return e.preventDefault(), sideEl.querySelector('.side-scroll .s-btn')?.click();
    if (e.key === 'ArrowDown') return e.preventDefault(), sideEl.querySelector('.side-scroll .s-btn, .side-scroll .proj-btn')?.focus();
  } });
  const pins = new Set(pinned());
  const projects = groups.map((g) => {
    const sess = g.sessions.filter((s) => !pins.has(s.path) && (!term || `${s.title} ${g.name} ${s.preview || ''}`.toLowerCase().includes(term)));
    const fresh = unlistedTabs(g).filter((t) => !term || `${t.name} ${g.name}`.toLowerCase().includes(term));
    if (term && !sess.length && !fresh.length && !g.name.toLowerCase().includes(term)) return null;
    const open = !!term || !collapsed.has(g.key);
    const all = !!term || expanded.has(g.key);
    const shown = open ? sess.slice(0, term ? 50 : all ? 300 : SHOWN) : [];
    const live = [...S.tabs.values()].filter((t) => !t.dead && t.streaming && keyPath(t.worktree?.source || t.workspace || '') === g.key).length;
    const toggle = () => {
      // In the rail a project is one icon: a click starts a session there instead of folding a hidden list.
      if (appEl.classList.contains('rail')) return newSession(g.path);
      collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key);
      lsSet('collapsed', [...collapsed]);
      drawSidebar();
    };
    return h('div', { class: 'proj' },
      h('div', { class: 'proj-head' },
        h('button', { class: 'proj-btn', type: 'button', title: live ? `${g.path}\n${live} working` : g.path, 'aria-expanded': String(open), onclick: toggle, oncontextmenu: (e) => (e.preventDefault(), projectMenu(g, e.currentTarget)), onkeydown: (e) => ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') && (e.preventDefault(), projectMenu(g, e.currentTarget)) },
          icon(open ? 'chevron-down' : 'chevron-right', 12, 'chev'), icon(open ? 'folder-open' : 'folder', 14, 'proj-ic'), h('span', { class: 'ell' }, g.name),
          live ? h('span', { class: 'proj-live', title: `${live} working`, 'aria-label': `${live} working` }, h('span', { class: 'dot run' })) : null,
          g.sessions.length ? h('span', { class: 'proj-n num' }, g.sessions.length) : null),
        h('span', { class: 'row-acts' },
          iconBtn('plus', `New session in ${g.name}`, () => newSession(g.path), 'sm'),
          iconBtn('more', `${g.name}: more`, (e) => projectMenu(g, e.currentTarget), 'sm'))),
      open ? fresh.map((t) => h('div', { class: 's-row' + (t.id === S.active ? ' cur' : '') },
        h('button', { class: 's-btn', type: 'button', title: t.name, 'aria-current': t.id === S.active ? 'page' : null, onclick: () => setActive(t.id) }, h('span', { class: dotCls(t) }), h('span', { class: 'ell grow' }, t.name), h('span', { class: 's-when', title: 'Not saved to the list yet' }, 'new')))) : null,
      shown.map((s) => sessionRow(s)),
      open && !term && !sess.length && !fresh.length ? h('div', { class: 's-none' }, g.sessions.length ? 'All pinned' : 'No conversations yet') : null,
      // The rest of a long project opens in place; it stays open until you fold it again.
      open && !term && sess.length > SHOWN ? h('button', { class: 's-more', type: 'button', 'aria-expanded': String(all), onclick: () => {
        all ? expanded.delete(g.key) : expanded.add(g.key);
        lsSet('expanded', [...expanded]);
        drawSidebar();
      } }, icon(all ? 'chevron-up' : 'chevron-down', 12), all ? 'Show fewer' : `Show ${sess.length - SHOWN} more`) : null);
  }).filter(Boolean);
  // The brand row stays in the document across redraws (re-inserting it would restart the logo's orbit); only the
  // rows after it are rebuilt.
  const top = brandTop();
  if (sideEl.firstElementChild !== top) replace(sideEl, top);
  while (top.nextSibling) top.nextSibling.remove();
  sideEl.append(
    h('button', { class: 'side-new', type: 'button', title: 'New session (Ctrl+N)', onclick: () => newSession() }, icon('plus', 15), 'New session', kbd('Ctrl+N')),
    h('nav', { class: 'side-nav', 'aria-label': 'Main' },
      h('button', { class: 'side-link' + (S.active ? '' : ' cur'), type: 'button', title: 'Home', 'aria-current': S.active ? null : 'page', onclick: () => newSession() }, icon('layers', 15), h('span', null, 'Home')),
      h('button', { class: 'side-link', type: 'button', title: 'Search everything (Ctrl+K)', onclick: () => openSearch() }, icon('search', 15), h('span', null, 'Search'), kbd('Ctrl+K'))),
    h('div', { class: 'side-search' }, icon('list', 14), search),
    h('div', { class: 'side-scroll', onkeydown: listKeys },
      runningList(),
      pinnedList(term),
      h('div', { class: 'side-h' }, h('span', null, 'Projects'), iconBtn('folder-plus', 'Open a project folder', openFolder, 'sm')),
      projects.length ? projects : term ? h('div', { class: 'side-empty' }, 'No matching conversations.') : h('div', { class: 'side-empty' }, h('span', null, 'Your projects will live here.'), h('button', { class: 'link', type: 'button', onclick: openFolder }, icon('folder-plus', 13), 'Open a folder'))),
    sideUpdate(icon('download', 15)),
    h('div', { class: 'side-foot' }, footStatus(), iconBtn('cog', 'Settings (Ctrl+,)', () => settingsDialog())),
  );
  sideEl.querySelector('.side-scroll').scrollTop = scroll;
  if (typing >= 0) {
    search.focus({ preventScroll: true });
    search.setSelectionRange(typing, typing);
  }
}

/**
 * The sidebar brand, built once and moved into each redraw: the sidebar is rebuilt on many events, and a new logo
 * would restart its orbit every time (the node snaps back to the start and looks stuck).
 */
let BRAND_TOP = null;
function brandTop() {
  // Built once: a new logo would restart its orbit. The button itself is Home.
  BRAND_TOP ||= h('div', { class: 'side-top' },
    h('button', { class: 'brand', type: 'button', onclick: () => newSession() },
      h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, logo(28, { alive: true })),
      h('span', { class: 'wordmark' }, 'ORBIX')),
    iconBtn('chevron-left', 'Collapse to icons', () => savePrefs({ rail: S.ui.rail !== true }), 'sm rail-btn'));
  const b = BRAND_TOP.firstChild;
  const rb = BRAND_TOP.lastChild;
  rb.title = S.ui.rail ? 'Expand the sidebar' : 'Collapse to icons';
  rb.setAttribute('aria-label', rb.title);
  rb.setAttribute('aria-pressed', String(S.ui.rail === true));
  const ver = S.env?.app?.version;
  b.title = ver ? `Home · ORBIX ${ver}` : 'Home';
  b.setAttribute('aria-label', 'Home');
  b.setAttribute('aria-current', S.active ? 'false' : 'page');
  return BRAND_TOP;
}

/**
 * The board of agents at the top of the sidebar: sessions working or waiting on you, and every session on its own
 * branch (with its branch) until it is closed. Each says what it is doing: working, needs you or done, and for how long.
 */
function runningList() {
  const live = [...S.tabs.values()].filter(onBoard);
  if (!live.length) return null;
  return h('div', { class: 'run-sec' },
    h('div', { class: 'side-h' }, h('span', null, 'Running')),
    live.map((t) => {
      const st = boardState(t);
      const waiting = st === 'needs you';
      return h('button', { class: 'run-row' + (t.id === S.active ? ' cur' : '') + (t.worktree ? ' has-branch' : ''), type: 'button', title: `${t.name}\n${t.worktree ? t.worktree.branch + '\n' : ''}${t.workspace}`, dataset: { id: t.id }, onclick: () => setActive(t.id) },
        h('span', { class: 'dot' + (waiting ? ' warn' : t.streaming ? ' run' : ' ok') }),
        h('span', { class: 'run-m' }, h('span', { class: 'ell' }, t.name), t.worktree ? h('span', { class: 'run-br ell' }, h('bdi', null, t.worktree.branch)) : null, h('span', { class: 'run-now ell' }, runNow(t, st))),
        h('span', { class: 'run-st num' + (waiting ? ' you' : t.streaming ? '' : ' idle') }, runLabel(t, st)));
    }));
}

const runTime = (t) => fmtSecs(Math.max(0, Math.floor((Date.now() - (t.turnStartedAt || Date.now())) / 1000)));
/** Right side of a board row: the running time while it works, how long the last turn took once it is done. */
function runLabel(t, st) {
  if (st === 'needs you') return 'Needs you';
  if (st === 'working') return runTime(t);
  const took = t.lastRunMs ? fmtSecs(Math.max(0, Math.round(t.lastRunMs / 1000))) : '';
  const word = st === 'merged' ? 'Merged' : st === 'kept' ? 'Kept' : 'Done';
  return took ? `${word} · ${took}` : word;
}
function runNow(t, st) {
  if (st === 'needs you') return t.dialogs.find(isApproval)?.title || 'Waiting for your OK';
  if (st !== 'working') return t.worktree && st === 'done' ? 'Ready to review' : st === 'merged' ? `In ${t.worktree?.baseBranch || 'the base branch'}` : 'Idle';
  const now = views.get(t.id)?.nowDoing?.();
  return now ? `${now[0]} ${now[1]}`.trim() : 'Working';
}

// Once a second: running times and steps in the sidebar, and the window title (it shows on the taskbar).
setInterval(() => {
  for (const row of sideEl.querySelectorAll('.run-row[data-id]')) {
    const t = S.tabs.get(row.dataset.id);
    if (!t || t.dead) continue;
    const state = boardState(t);
    const st = row.querySelector('.run-st');
    const now = row.querySelector('.run-now');
    if (st && state === 'working') st.textContent = runTime(t);
    if (now) now.textContent = runNow(t, state);
  }
  syncTitle();
}, 1000);
function syncTitle() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  const wait = live.filter((t) => t.dialogs.some(isApproval)).length;
  const run = live.filter((t) => t.streaming).length;
  const title = wait ? `(${wait}) Needs your OK · ORBIX` : run ? `Working (${run}) · ORBIX` : 'ORBIX';
  if (document.title !== title) document.title = title;
}

/** Sidebar footer: whether the agent can work, and with which provider. */
function footStatus() {
  const on = (S.engine?.providers || []).filter((p) => p.configured);
  const names = on.map((p) => p.name.replace(/ \(.*\)$/, ''));
  // Every connected provider is a sign-in its provider ended: say so, and open Providers to sign in again.
  if (on.length && on.every((p) => p.signInError)) {
    return h('button', { class: 'foot-status', type: 'button', title: `${names.join(', ')}: the sign-in has ended. Sign in again in Settings → Providers.`, onclick: () => settingsDialog('engine') }, h('span', { class: 'dot warn' }), h('span', { class: 'ell' }, names.join(', ')), h('span', { class: 'fs-k' }, 'Sign in'));
  }
  const ready = engineReady();
  const text = ready ? names.join(', ') : 'No model connected';
  return h('button', { class: 'foot-status', type: 'button', title: ready ? `Connected: ${names.join(', ')}` : 'Add an API key or a local model', onclick: () => settingsDialog(ready ? 'start' : 'engine') }, h('span', { class: 'dot' + (ready ? ' ok' : ' warn') }), h('span', { class: 'ell' }, text), ready ? null : h('span', { class: 'fs-k' }, 'Connect'));
}

function toggleTheme() {
  savePrefs({ theme: document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark' });
}

/** Show the home composer (optionally for one project). Open tabs stay open. */
let homeRequested = false;
function newSession(project, opts) {
  homeRequested = true;
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
    // cwdDisplay is the Windows form of the folder: the file tree, git panel and @mentions all use it.
    await openTab({ workspace: s.cwdDisplay || s.cwd, resume: s.path, title: s.title });
  } catch (e) {
    if (e.status !== 409) return toast(e.message, 'error', 8000);
    // Already open in a tab this window has not adopted yet: find that process and switch to it.
    const chain = new Set([s.path, ...(s.chain || [])]);
    const procs = await api.get('/api/procs').then((j) => j.procs).catch(() => []);
    const p = procs.find((x) => (x.resume && chain.has(x.resume)) || (x.file && chain.has(x.file)));
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

/** The project of the active session, in the top bar: new session here, show the folder, copy its path. */
function workspaceChip(t) {
  const chip = h('button', { class: 'tb-ws', type: 'button', title: t.workspace, 'aria-haspopup': 'menu' }, icon('folder', 13), h('span', { class: 'ell' }, baseName(t.workspace)), icon('chevron-down', 11, 'cbtn-chev'));
  chip.addEventListener('click', () => popMenu(chip, [
    { header: t.workspace },
    { label: 'New session in this project', hint: 'Ctrl+N', run: () => newSession(t.workspace) },
    { label: 'Show in Explorer', run: () => api.post('/api/fs/reveal', { path: t.workspace }).catch((e) => toast(e.message, 'error')) },
    { label: 'Copy path', run: () => copyText(t.workspace) },
  ], { minWidth: 240 }));
  return chip;
}

let topSig = '';
function drawTop() {
  const t = activeTab();
  const tabs = [...S.tabs.values()];
  topEl.classList.toggle('busy', !!t?.streaming && !t.dead);
  // Rebuilt only when what it shows changed, so a tab under the pointer or the keyboard is not replaced mid-gesture.
  const sig = JSON.stringify([S.active, sideShown(), panelShown(), t?.workspace, tabs.map((x) => [x.id, x.name, x.workspace, !!x.streaming, !!x.dead, !!x.unread])]);
  if (sig === topSig && topEl.querySelector('.tabs')) return;
  topSig = sig;
  const focusedTab = document.activeElement?.closest?.('.tab') ? document.activeElement.dataset.id : null;
  replace(
    topEl,
    iconBtn('panel-left', 'Sidebar (Ctrl+B)', toggleSidebar, 'tb-side' + (sideShown() ? ' on' : '')),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Open sessions' },
      tabs.map((x, i) => h('div', { class: 'tab' + (S.active === x.id ? ' cur' : ''), role: 'tab', dataset: { id: x.id }, 'aria-selected': String(S.active === x.id), tabindex: S.active === x.id || (!t && i === 0) ? '0' : '-1', title: `${x.name}\n${x.workspace}`, onclick: () => setActive(x.id), ondblclick: () => renameTab(x), onauxclick: (e) => e.button === 1 && closeWithCheck(x), onkeydown: (e) => {
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
    h('button', { class: 'workspace-command', type: 'button', 'aria-label': 'Search workspace', onclick: () => openSearch() }, icon('search', 13), h('span', null, 'Search'), kbd('Ctrl+K')),
    t ? workspaceChip(t) : null,
    t ? iconBtn('more', 'Session actions', (e) => sessionMenu(t, e.currentTarget, { rename: () => renameTab(t), close: () => closeWithCheck(t) })) : null,
    t ? iconBtn('panel-right', 'Side panel (Ctrl+J)', togglePanel, 'tb-panel' + (panelShown() ? ' on' : '')) : null,
  );
  topEl.classList.toggle('busy', !!t?.streaming && !t.dead);
  topEl.querySelector('.tab.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focusedTab) topEl.querySelector(`.tab[data-id="${CSS.escape(focusedTab)}"]`)?.focus({ preventScroll: true });
}

const homeHandlers = {
  search: openSearch,
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
  for (const id of [...views.keys()]) {
    if (S.tabs.has(id)) continue;
    views.get(id)?.destroy?.();
    views.delete(id);
  }
  if (!t) {
    if (!sessEl.hidden) sessEl.firstChild?._view?.detach();
    sessEl.hidden = true;
    sessEl.replaceChildren(); // a closed tab's view must not stay attached to the page
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
on('update', () => drawSidebar());
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
barHandlers.rename = (t) => renameTab(t);
// Focus mode only makes sense on a conversation: going Home leaves it.
on('active', () => !activeTab() && zenOn() && toggleZen(false));
on('tab:messages', (tab, d) => {
  const v = viewOf(tab);
  if (!v) return;
  if (d.type === 'reset') v.renderAll();
  else if (d.type === 'remove') v.removeMsg(d.msg);
  else v.appendMsg(d.msg);
  if (d.msg?.role === 'user') drawTop();
  v.bar.update();
});
on('tab:live', (tab) => viewOf(tab)?.renderLive());
on('tab:tool', (tab, id) => viewOf(tab)?.updateTool(id));
// The sidebar logo breathes while any session is working.
const syncBusy = () => {
  document.documentElement.classList.toggle('agent-busy', [...S.tabs.values()].some((t) => t.streaming && !t.dead));
};
on('tab:state', (tab) => (viewOf(tab)?.updateComposer(), syncBusy()));
on('tabs', syncBusy);
on('tab:status', (tab) => {
  const v = viewOf(tab);
  v?.updateComposer();
  if (tab.dead && v && !v.deadShown) v.showDead();
  drawTop();
  drawSidebar();
  if (!activeTab()) drawWelcome(); // Home shows working / waiting states
});
on('tab:editor', (tab) => viewOf(tab)?.setText(tab.draft));
on('tab:dialog', (tab) => {
  viewOf(tab)?.updateApproval();
  if (tab === activeTab()) syncExtDialogs(tab);
  drawSidebar(); // "needs you" in the Running list
  if (!activeTab()) drawWelcome();
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
on('run:open', () => showTab('run'));
on('run:file', (tab, path) => { if (tab === activeTab()) viewFile(tab, path); });
on('run:reveal', (tab, id) => {
  if (tab !== activeTab()) return;
  const v = viewOf(tab); if (!v) return;
  const index = tab.messages.findIndex(m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'toolCall' && c.id === id));
  if (index >= 0 && index < tab.messages.length - v.limit) { v.limit = tab.messages.length-index; v.renderAll(); }
  const card = v.tin.querySelector(`.tool[data-id="${CSS.escape(id)}"]`);
  if (card) { card.classList.add('open'); card._fill?.(); v.timeline.jumpTo(card); v.showJump(true); }
  else toast('This tool is not available in the loaded transcript.', 'info');
});
on('home', (project) => newSession(project));

function paletteItems() {
  const t = activeTab();
  const dark = document.documentElement.dataset.mode === 'dark';
  const items = [
    { group: 'General', icon: 'plus', label: 'New session', key: 'Ctrl+N', run: () => newSession() },
    { group: 'General', icon: 'plus', label: 'New session without saving it', run: () => newSession(undefined, { ephemeral: true }) },
    { group: 'General', icon: 'folder-plus', label: 'Open project folder…', run: openFolder },
    { group: 'General', icon: 'cog', label: 'Settings', key: 'Ctrl+,', run: () => settingsDialog() },
    { group: 'General', icon: 'key', label: 'Providers', run: () => settingsDialog('engine') },
    { group: 'General', icon: 'trash', label: 'Manage conversations…', run: openCleanup },
    { group: 'General', icon: 'activity', label: 'Diagnostics', run: openDiagnostics },
    { group: 'General', icon: 'compass', label: 'How ORBIX works', run: openHelp },
    { group: 'General', icon: 'keyboard', label: 'Keyboard shortcuts', run: shortcutsDialog },
    { group: 'View', icon: dark ? 'sun' : 'moon', label: dark ? 'Light theme' : 'Dark theme', run: toggleTheme },
    { group: 'View', icon: 'panel-left', label: 'Toggle sidebar', key: 'Ctrl+B', run: toggleSidebar },
  ];
  if (t) {
    items.push({ group: 'View', icon: 'panel-right', label: 'Toggle side panel', key: 'Ctrl+J', run: togglePanel });
    items.push({ group: 'View', icon: 'eye', label: zenOn() ? 'Leave focus mode' : 'Focus mode', key: 'Ctrl+Shift+F', run: () => toggleZen() }, { group: 'View', icon: 'wrap', label: 'Toggle wide reading column', run: toggleWide }, { group: 'Session', icon: 'search', label: 'Find in conversation', key: 'Ctrl+F', run: () => viewOf(t)?.bar.openFind() }, { group: 'Session', icon: 'list', label: 'Jump to one of your messages…', key: 'Ctrl+Shift+O', run: () => viewOf(t)?.bar.openOutline() });
    for (const [k, l, ic] of [['run', 'Run inspector', 'activity'], ['files', 'Files', 'folder'], ['changes', 'Changes', 'branch'], ['todos', 'Plan', 'list'], ['agents', 'Agents', 'users'], ['console', 'Console', 'terminal']]) items.push({ group: 'View', icon: ic, label: `Show ${l}`, run: () => showTab(k) });
    items.push({ group: 'Session', icon: 'pencil', label: 'Rename session…', run: () => renameTab(t) }, { group: 'Session', icon: 'copy', label: 'Copy conversation as Markdown', run: () => copyConversation(t) }, { group: 'Session', icon: 'x', label: 'Close session', run: () => closeWithCheck(t) });
    for (const c of t.commands) items.push({ group: 'Slash commands', icon: 'command', label: `/${c.name}`, hint: c.description, run: () => emit('insert', `/${c.name} `) });
  }
  // Every saved conversation, searchable by its title and by its first message.
  for (const s of S.sessions) items.push({ group: 'Conversations', scope: 'conversations', icon: 'message', label: s.title, hint: `${baseName(s.cwdDisplay || s.cwd)} · ${timeAgo(s.mtime)}`, text: s.preview, run: () => openSession(s) });
  for (const g of groupSessions().filter((x) => x.path)) items.push({ group: 'Projects', scope: 'projects', icon: 'folder', label: g.name, hint: `${g.sessions.length} conversation${g.sessions.length === 1 ? '' : 's'} · ${g.path}`, run: () => newSession(g.path) });
  return items;
}

/** Files of the open session's project for the search box, from the same index as @-mentions. */
async function searchFiles(query) {
  const t = activeTab();
  if (!t?.workspace) return [];
  const j = await api.get(`/api/fs/find?root=${encodeURIComponent(t.workspace)}&q=${encodeURIComponent(query)}`);
  return (j.files || []).slice(0, 30).map((f) => {
    const name = f.split('/').pop();
    return { group: 'Files', scope: 'files', icon: 'file', label: name, hint: f.length > name.length ? f.slice(0, -name.length - 1) : baseName(t.workspace), run: () => viewFile(t, f) };
  });
}

/** Ctrl+K: search conversations, projects, commands and (in a session) the project's files. */
function openSearch(scope) {
  if (document.querySelector('.palette')) return;
  palette(paletteItems, { files: activeTab()?.workspace ? searchFiles : null, scope });
}

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'n') return e.preventDefault(), newSession();
    if (k === 'k') return e.preventDefault(), openSearch();
    if (k === ',') return e.preventDefault(), settingsDialog();
    if (k === 'b') return e.preventDefault(), toggleSidebar();
    if (k === 'j') return e.preventDefault(), togglePanel();
    if (k === 'f' && activeTab() && !document.querySelector('.scrim')) return e.preventDefault(), viewOf(activeTab())?.bar.openFind();
    if (k === 'l') return e.preventDefault(), (activeTab() ? viewOf(activeTab())?.focus() : homeEl.querySelector('textarea')?.focus());
  }
  // Ctrl+= / Ctrl+- / Ctrl+0: conversation text size (the same setting as Appearance → Message text size).
  if (mod && !e.altKey && ['=', '+', '-', '0'].includes(e.key)) {
    e.preventDefault();
    const cur = S.ui.fontSize || 14;
    const next = e.key === '0' ? 14 : Math.max(12, Math.min(18, cur + (e.key === '-' ? -1 : 1)));
    if (next !== cur) savePrefs({ fontSize: next });
    return toast(next === cur && e.key !== '0' ? `Text size is at its ${next === 18 ? 'largest' : 'smallest'} (${next}px)` : `Text size ${next}px`, 'info', 1400);
  }
  // Ctrl+Tab / Ctrl+Shift+Tab: the next / previous open session.
  if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
    const list = [...S.tabs.values()];
    if (!list.length) return;
    e.preventDefault();
    const i = list.findIndex((t) => t.id === S.active);
    const n = i < 0 ? (e.shiftKey ? list.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
    return setActive(list[n].id);
  }
  if (mod && e.shiftKey && !e.altKey && activeTab() && !document.querySelector('.scrim')) {
    const k = e.key.toLowerCase();
    if (k === 'r') return e.preventDefault(), showTab('run');
    if (k === 'f') return e.preventDefault(), toggleZen();
    if (k === 'o') return e.preventDefault(), viewOf(activeTab())?.bar.openOutline();
  }
  // Esc anywhere outside a text field stops the agent (fields, menus and dialogs handle Esc themselves first).
  if (e.key === 'Escape' && !mod && !e.defaultPrevented && !e.target.closest?.('input, textarea, select, .scrim, .menu')) {
    const t = activeTab();
    const v = t && viewOf(t);
    if (v && (t.streaming || v.approvalDlg)) return e.preventDefault(), v.onEscape();
  }
  // 1 / 2 answer a waiting approval from anywhere outside a text field, not only while the card has focus.
  if (/^[1-9]$/.test(e.key) && !mod && !e.altKey && !e.defaultPrevented && !e.target.closest?.('input, textarea, select, [contenteditable], .scrim, .menu')) {
    const t = activeTab();
    const v = t && viewOf(t);
    if (v?.approvalDlg) return v.onApprovalKey(e);
  }
  if (e.altKey && !mod && /^[1-9]$/.test(e.key)) {
    const t = [...S.tabs.values()][+e.key - 1];
    if (t) (e.preventDefault(), setActive(t.id));
  }
  // Alt+↑ / Alt+↓: the previous / next message of yours in the conversation (the timeline's jump).
  if (e.altKey && !mod && !e.shiftKey && !e.defaultPrevented && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest?.('.scrim, .menu')) {
    const t = activeTab();
    const v = t && viewOf(t);
    if (v?.timeline) (e.preventDefault(), v.timeline.stepYou(e.key === 'ArrowUp' ? -1 : 1));
  }
});

const banner = $('#banner');
const setBanner = (msg) => {
  banner.hidden = !msg;
  banner.textContent = msg || '';
};

/** Open a tab for every running session this window does not show yet. Returns the ids it just loaded. */
async function adoptRunning(procs) {
  const fresh = new Set();
  for (const p of procs) {
    if (S.tabs.has(p.id)) continue;
    fresh.add(p.id);
    const tab = new Tab(p.id, p.workspace, { resume: p.resume, title: p.title }); // the title you gave it, not its first message
    S.tabs.set(p.id, tab);
    try {
      const c = await rpc(p.id, { type: 'get_available_commands' });
      tab.commands = c.data?.commands || [];
      await attach(tab);
    } catch {}
    tab.ready = true;
    for (const ev of tab.buffer.splice(0)) routeEvent(p.id, ev);
  }
  if (!S.active && S.tabs.size && !homeRequested) setActive([...S.tabs.keys()][0]);
  else emit('tabs');
  return fresh;
}

async function boot() {
  initInterface();
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
      if (g.g === 'hello') onHello(g.procs, await adoptRunning(g.procs));
      else if (g.g === 'procs') onProcs(g.procs);
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
