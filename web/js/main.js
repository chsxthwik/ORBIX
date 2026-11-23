// ORBIX front-end bootstrap: layout, sidebar, keyboard, and routing of events to views. The window chrome (menu row,
// toolbar, history) is drawn by shell.js with the actions defined here.
import './desktop.js';
import { $, h, icon, iconBtn, replace, toast, timeAgo, baseName, lsGet, lsSet, fmtElapsed, projTile, dotGrid, fmtTokens, keyHint } from './dom.js';
import { sideIcon } from './side-icons.js';
import { openConnect } from './connect.js';
import { api, rpc, connectEvents } from './api.js';
import { brandMark } from './brands.js';
import { moveToMachine, onMachine, backToThisPc } from './machines.js';
import { S, Tab, on, emit, activeTab, loadEnv, loadSessions, openTab, closeTab, setActive, routeEvent, onHello, onProcs, attach, savePrefs, groupSessions, unlistedTabs, tabForSession, engineReady, renameSession, cleanName, keyPath, agentOf } from './store.js';
import { TabView, sessionMenu, copyConversation } from './session.js';
import { drawHome, setHomeProject, homeProject, insertHome } from './home.js';
import { openCleanup, confirmDeleteConversation } from './cleanup.js';
import { openDiagnostics } from './diagnostics.js';
import { initNotify } from './notify.js';
import { openHelp } from './help.js';
import { mountPanel, showTab, viewFile, stepPanelTab, openSurface } from './panels.js';
import { mountTerminal, toggleTerminal, terminalShown } from './terminal.js';
import { projectPopover, loadInfo } from './project.js';
import { actionFor, comboOf, firstKey } from './keys.mjs';
import { browserPrefs, desktopBrowser, canShowInside } from './browser.js';
import { settingsSearchItems, openFeedback } from './settings.js';
import { applyExtraPrefs, keepAwakeMode, askBeforeClose, askBeforeArchive, askBeforeUnpin, showRunningSection } from './prefs-extra.js';
import { H as shell, drawMenubar, drawToolbar, tickToolbar, navRecord, navGo, bindHoverCards, updatedLabel } from './shell.js';
import { folderPicker, palette, syncExtDialogs, confirmDialog, promptDialog, popMenu, popover, isApproval } from './dialogs.js';
import { onBoard, boardState } from './review.js';
import { openSettings as settingsDialog } from './settings.js';
import { toggleZen, toggleWide, zenOn } from './workbench.js';
import { initInterface } from './interface.js';
import { initBackdrop, SCENES } from './backdrop.js';
import { refreshAutomations } from './automations.js';
import { selectPluginsTab } from './customize.js';
import { HUB_LINKS, isCustomize, lastCustomize } from './hub-nav.js';
import { initRuns, openHub, closeHub, isHub, hubView, draw as drawHub, onRunEvent, reviewCount, workingCount } from './runs.js';

let week = null, weekAt = 0; // the sidebar's This week card (see loadWeek)

// No layout animation until the saved layout has been applied (boot() removes this).
document.documentElement.classList.add('still');
const views = new Map();
const sideEl = $('#sidebar');
const topEl = $('#topbar');
const stripEl = $('#tabstrip');
const menuEl = $('#menubar');
const mainEl = $('.main');
const sessEl = $('#session');
const homeEl = $('#welcome');
const runsEl = $('#runs');
const appEl = $('#app');
let searchTerm = '';
// The conversation filter opens from the funnel button beside Projects and stays open while it has text.
let filterOpen = false;
const collapsed = new Set(lsGet('collapsed', []));
// Projects whose whole list is shown (by default a project shows its newest conversations only).
const expanded = new Set(lsGet('expanded', []));
const SHOWN = 8;

// In narrow windows the sidebar and side panel float over the content; there they open on demand and are not saved.
const narrowSide = matchMedia('(max-width: 760px)');
const narrowPanel = matchMedia('(max-width: 1100px)');
const overlay = { side: false, panel: false };

// Every theme belongs to a mode (dark or light); the mode drives color-scheme and anything that only needs to know which.
const THEMES = { dark: 'dark', light: 'light', midnight: 'dark', frost: 'light', graphite: 'dark', tokyo: 'dark', mocha: 'dark', rosepine: 'dark', nord: 'dark', dracula: 'dark', gruvbox: 'dark', latte: 'light', dawn: 'light', orbix: 'dark', sunset: 'dark', nebula: 'dark', aurora: 'dark' };
/** Retired themes and what they became. */
const THEME_ALIAS = { koi: 'latte', dusk: 'nebula' };
// The sidebar can be dragged between these widths (double-click the edge to reset).
const SIDE_MIN = 220, SIDE_MAX = 360, SIDE_W = 260, SIDE_RAIL = 56;

/** Settings → Appearance: font, contrast, your own colours, and screen reader mode. */
const FONTS = { google: '', segoe: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif", system: 'system-ui, sans-serif' };
const LOOK_VARS = ['--bg', '--chrome', '--bg-side', '--bg-raise', '--bg-raise-2', '--bg-inset', '--bg-field', '--bg-modal', '--bubble', '--fg', '--fg-2', '--fg-3', '--accent', '--accent-solid', '--accent-soft', '--accent-line', '--on-accent'];
const hexOk = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
/** Black or white text on a colour, whichever reads better. */
const onColor = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0B0B0E' : '#FFFFFF';
};
function applyLook(u, root) {
  if (FONTS[u.font]) root.style.setProperty('--font', FONTS[u.font]);
  else root.style.removeProperty('--font');
  root.classList.toggle('contrast-strong', u.contrast === 'strong');
  root.classList.toggle('sr', u.screenReader === true);
  for (const v of LOOK_VARS) root.style.removeProperty(v);
  const c = u.colors || {};
  const light = root.dataset.mode === 'light';
  if (hexOk(c.bg)) {
    const set = (k, v) => root.style.setProperty(k, v);
    const toward = light ? '#000' : '#fff';
    set('--bg', c.bg);
    set('--chrome', `color-mix(in srgb, ${c.bg} 82%, ${light ? '#fff' : '#000'})`);
    set('--bg-side', `color-mix(in srgb, ${c.bg} 82%, ${light ? '#fff' : '#000'})`);
    set('--bg-raise', `color-mix(in srgb, ${c.bg} 94%, ${toward})`);
    set('--bg-raise-2', `color-mix(in srgb, ${c.bg} 89%, ${toward})`);
    set('--bg-modal', `color-mix(in srgb, ${c.bg} 96%, ${toward})`);
    set('--bg-inset', `color-mix(in srgb, ${c.bg} 90%, ${light ? '#fff' : '#000'})`);
    set('--bg-field', `color-mix(in srgb, ${c.bg} 96%, ${toward})`);
    set('--bubble', `color-mix(in srgb, ${c.bg} 88%, ${toward})`);
  }
  if (hexOk(c.fg)) {
    root.style.setProperty('--fg', c.fg);
    root.style.setProperty('--fg-2', `color-mix(in srgb, ${c.fg} 70%, var(--bg))`);
    root.style.setProperty('--fg-3', `color-mix(in srgb, ${c.fg} 50%, var(--bg))`);
  }
  if (hexOk(c.accent)) {
    root.style.setProperty('--accent', c.accent);
    root.style.setProperty('--accent-solid', c.accent);
    root.style.setProperty('--accent-soft', `color-mix(in srgb, ${c.accent} 12%, transparent)`);
    root.style.setProperty('--accent-line', `color-mix(in srgb, ${c.accent} 42%, transparent)`);
    root.style.setProperty('--on-accent', onColor(c.accent));
  }
}

function applyPrefs() {
  const u = S.ui;
  const root = document.documentElement;
  window.orbixDesktop?.setZoom(typeof u.uiScale === 'number' && Number.isFinite(u.uiScale) && u.uiScale >= 0.5 && u.uiScale <= 2 ? u.uiScale : 1);
  const want = THEME_ALIAS[u.theme] || u.theme;
  const name = THEMES[want] ? want : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; // 'system' or unknown
  root.dataset.theme = name;
  root.dataset.mode = THEMES[name];
  if (SCENES.includes(name)) root.dataset.scene = name;
  else delete root.dataset.scene;
  lsSet('look', { theme: name });
  root.style.setProperty('--fs', (u.fontSize || 14) + 'px');
  applyLook(u, root);
  applyExtraPrefs(u, root);
  root.classList.toggle('compact', u.density === 'compact');
  root.dataset.density = u.density === 'compact' ? 'compact' : 'comfortable';
  root.style.setProperty('--panel-w', (u.panelW || 380) + 'px');
  const side = narrowSide.matches ? overlay.side : u.sidebar !== false;
  // The rail: the sidebar as a column of icons (Ctrl+B or the sidebar button), remembered in prefs.
  const rail = side && !narrowSide.matches && u.sideRail === true;
  root.style.setProperty('--side-w', (rail ? SIDE_RAIL : Math.min(SIDE_MAX, Math.max(SIDE_MIN, u.sidebarW || SIDE_W))) + 'px');
  appEl.classList.toggle('side-rail', rail);
  // A conversation's panel, or on Home the panel of the project chosen there; closed until you open it.
  const panel = (!!activeTab() || !!homeProject()) && !isHub() && (narrowPanel.matches ? overlay.panel : u.rightPanel === true);
  appEl.classList.toggle('no-side', !side);
  appEl.classList.toggle('no-panel', !panel);
  appEl.classList.toggle('overlay-side', side && narrowSide.matches);
  appEl.classList.toggle('overlay-panel', panel && narrowPanel.matches);
  if (rail !== sideRailWas) (sideRailWas = rail), drawSidebar();
}
let sideRailWas = false;
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);
for (const mq of [narrowSide, narrowPanel]) mq.addEventListener('change', () => ((overlay.side = overlay.panel = false), applyPrefs(), drawTop()));

const sideShown = () => !appEl.classList.contains('no-side');
const panelShown = () => !appEl.classList.contains('no-panel');
/** Ctrl+B and the sidebar button: the full sidebar and the rail, in turn; a closed sidebar opens in full. */
function toggleSidebar() {
  if (narrowSide.matches) (overlay.side = !overlay.side), applyPrefs(), drawTop();
  else if (S.ui.sidebar === false) savePrefs({ sidebar: true, sideRail: false });
  else savePrefs({ sideRail: S.ui.sideRail !== true });
}
/** The side panel across the whole window (the conversation hidden), and back. */
const panelMax = () => appEl.classList.contains('panel-max');
function togglePanelMax() {
  if (!panelShown()) return;
  appEl.classList.toggle('panel-max');
  drawTop();
}
function togglePanel() {
  if (!activeTab() && !homeProject()) return;
  // Opening the panel from the toolbar (or Ctrl+J) shows the tab it had last (Changes the first time).
  if (!panelShown()) return showTab(S.ui.rightTab || 'changes');
  if (narrowPanel.matches) (overlay.panel = false), applyPrefs(), drawTop();
  else savePrefs({ rightPanel: false });
  appEl.classList.remove('panel-max');
}
// Home's project decides whether its side panel and the panel button are there.
on('home:project', () => {
  applyPrefs();
  drawTop();
});
on('panel:open', () => {
  if (narrowPanel.matches && !overlay.panel) (overlay.panel = true), applyPrefs(), drawTop();
});
// A click outside a floating sidebar or panel closes it.
appEl.addEventListener('mousedown', (e) => {
  if (overlay.side && narrowSide.matches && !sideEl.contains(e.target) && !e.target.closest('.tb-side')) (overlay.side = false), applyPrefs(), drawTop();
  if (overlay.panel && narrowPanel.matches && !$('#panel').contains(e.target) && !e.target.closest('.tb-panel')) (overlay.panel = false), applyPrefs(), drawTop();
});

// The main sheet keeps at least this much room while you drag an edge.
const MAIN_MIN = 360;
// Drag the sidebar's edge this far past its narrowest width and it closes; drag back out (still holding) and it opens.
const SNAP_SHUT = 64;
/**
 * A draggable edge between two columns. The column follows the pointer exactly: the width moves by as much as the
 * pointer has moved since the press (so pressing never makes it jump), it is written once per frame, and width
 * animations are off while you drag. The pointer is captured, so releasing outside the window (or over an embedded
 * page) still ends the drag. Esc puts the width back; double-click or Enter resets it; the arrow keys move it.
 * `snapShut` (the sidebar): dragging well past the narrowest width closes the column.
 */
function resizer(id, { target, varName, key, min, max, fromRight, reset, snapShut, rail = 0 }) {
  const el = $(id);
  const root = document.documentElement;
  const col = $(target);
  // The column on the other side of the main sheet, when it is docked, also takes room.
  const other = () => (fromRight ? (sideShown() && !narrowSide.matches ? sideEl.offsetWidth : 0) : panelShown() && !narrowPanel.matches ? $('#panel').offsetWidth : 0);
  // The sheet's own min-width (CSS may ask for more, to keep the conversation readable) counts too.
  const mainMin = () => Math.max(MAIN_MIN, parseFloat(getComputedStyle(mainEl).minWidth) || 0);
  const limit = () => Math.max(min, Math.min(max, innerWidth - mainMin() - other()));
  const clamp = (w) => Math.round(Math.max(min, Math.min(limit(), w)));
  const current = () => Math.round(col.getBoundingClientRect().width) || S.ui[key] || reset;
  const sync = (w) => {
    el.setAttribute('aria-valuemin', min);
    el.setAttribute('aria-valuemax', limit());
    el.setAttribute('aria-valuenow', w);
  };
  const set = (w) => {
    root.style.setProperty(varName, w + 'px');
    S.ui[key] = w;
    sync(w);
  };
  el.tabIndex = 0;
  el.addEventListener('focus', () => sync(current()));
  if (reset) el.addEventListener('dblclick', () => (set(clamp(reset)), savePrefs({ [key]: S.ui[key] })));
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = fromRight ? 'ArrowLeft' : 'ArrowRight';
    const shrink = fromRight ? 'ArrowRight' : 'ArrowLeft';
    const w = current();
    const next = e.key === grow ? w + step : e.key === shrink ? w - step : e.key === 'Home' ? min : e.key === 'End' ? limit() : e.key === 'Enter' && reset ? reset : null;
    if (next === null) return;
    e.preventDefault();
    set(clamp(next));
    savePrefs({ [key]: S.ui[key] });
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = current();
    let want = startW, shut = false, railed = rail > 0 && appEl.classList.contains('side-rail'), frame = 0, done = false;
    const wasRail = railed;
    el.classList.add('drag');
    document.body.classList.add('resizing');
    root.classList.add('sizing'); // width transitions off: the column sticks to the pointer
    const showShut = (on) => {
      if (on === shut) return;
      shut = on;
      // A closing sidebar slides away (transitions back on); one that reopens follows the pointer again.
      root.classList.toggle('sizing', !on);
      appEl.classList.toggle('no-side', on);
    };
    // Narrower than the sidebar's minimum it snaps to the rail; narrower than the rail it closes.
    const showRail = (on) => {
      if (on === railed) return;
      railed = on;
      appEl.classList.toggle('side-rail', on);
      if (on) root.style.setProperty(varName, rail + 'px');
      drawSidebar();
    };
    const paint = () => {
      frame = 0;
      if (rail) {
        showShut(want < rail - 20);
        showRail(!shut && want < min - SNAP_SHUT / 2);
        if (!shut && !railed) set(clamp(want));
        return;
      }
      if (snapShut) showShut(want < min - SNAP_SHUT);
      if (!shut) set(clamp(want));
    };
    const move = (ev) => {
      want = startW + (fromRight ? startX - ev.clientX : ev.clientX - startX);
      frame ||= requestAnimationFrame(paint);
    };
    const end = (cancel) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      removeEventListener('keydown', esc, true);
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove('drag');
      document.body.classList.remove('resizing');
      if (cancel) {
        showShut(false);
        set(startW);
      } else if (!shut) {
        paint();
      }
      // Let the last width land before transitions come back on.
      requestAnimationFrame(() => root.classList.remove('sizing'));
      if (cancel && rail) showRail(wasRail);
      if (shut && !cancel) {
        if (!wasRail) set(startW); // it reopens at the width it had
        return savePrefs({ sidebar: false, ...(rail ? { sideRail: false } : {}) });
      }
      if (rail && !cancel && railed !== wasRail) return savePrefs({ sideRail: railed, ...(railed ? {} : { [key]: S.ui[key] }) });
      if (railed) return;
      if (S.ui[key] !== startW) savePrefs({ [key]: S.ui[key] });
    };
    const up = () => end(false);
    const esc = (ev) => ev.key === 'Escape' && (ev.preventDefault(), ev.stopPropagation(), end(true));
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    addEventListener('keydown', esc, true);
  });
}
resizer('#rs-side', { target: '#sidebar', varName: '--side-w', key: 'sidebarW', min: SIDE_MIN, max: SIDE_MAX, fromRight: false, reset: SIDE_W, snapShut: true, rail: SIDE_RAIL });
resizer('#rs-panel', { target: '#panel', varName: '--panel-w', key: 'panelW', min: 280, max: 720, fromRight: true, reset: 380 });

// A session's status in the sidebar: ended, waiting for your OK, working, finished while you were away, or just open.
const dotState = (t) => (t.dead ? 'dead' : t.dialogs?.some(isApproval) ? 'warn' : t.streaming ? 'run' : t.unread ? 'unread' : '');
const dotCls = (t) => 'dot' + (dotState(t) ? ` ${dotState(t)}` : '');
/** A conversation's state in the sidebar, only when it has one: working, needs you, unread or ended (an open, idle one shows nothing). */
// A working conversation shows the dot grid in its row's corner instead of a dot in front.
// One status system everywhere: working = live dots (blue), needs you = amber dot and "Needs you", unread = a small
// ink dot, ended or idle = nothing.
const stateDot = (t) => (t && ['warn', 'unread'].includes(dotState(t)) ? h('span', { class: dotCls(t), title: { warn: 'Needs your OK', unread: 'Finished while you were away' }[dotState(t)] }) : null);
const working = (t) => !!t && dotState(t) === 'run';

// Pinned conversations, by session file, saved with the other UI preferences.
const pinned = () => (Array.isArray(S.ui.pinned) ? S.ui.pinned : []);
/** Archived conversations: kept on disk, left out of the sidebar until you show them (the filter menu). */
const archived = () => (Array.isArray(S.ui.archived) ? S.ui.archived : []);
async function toggleArchive(s) {
  const list = archived();
  const on = list.includes(s.path);
  if (!on && askBeforeArchive() && !(await confirmDialog('Archive conversation', `Archive “${s.title}”? It leaves the sidebar; the filter beside Projects shows archived conversations.`, { ok: 'Archive' }))) return;
  savePrefs({ archived: on ? list.filter((p) => p !== s.path) : [s.path, ...list].slice(0, 500), ...(on ? {} : { pinned: pinned().filter((p) => p !== s.path) }) });
  if (!on) toast('Archived. Show it again from the filter menu beside Projects.', 'info', 2600);
}
async function togglePin(s) {
  const list = pinned();
  if (list.includes(s.path) && askBeforeUnpin() && !(await confirmDialog('Unpin conversation', `Unpin “${s.title}”?`, { ok: 'Unpin' }))) return;
  savePrefs({ pinned: list.includes(s.path) ? list.filter((p) => p !== s.path) : [s.path, ...list].slice(0, 20) });
}

/** Rename a conversation, open or not: an open one through its session, a saved one in its file. */
async function renameConversation(s) {
  // A double-click opens the conversation with its first click: rename the tab once it is open.
  await opening.get(s.path)?.catch(() => {});
  const tab = tabForSession(s);
  if (tab) return renameTab(tab);
  const n = cleanName(await promptDialog('Rename conversation', 'Name', s.title));
  if (!n || n === s.title) return;
  try {
    // The server renames through the session when the conversation is open somewhere (another window, an automation).
    await api.post('/api/sessions/rename', { path: s.path, title: n });
    await loadSessions();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function rowMenu(s, anchor) {
  const tab = tabForSession(s);
  const isPinned = pinned().includes(s.path);
  const isArchived = archived().includes(s.path);
  popMenu(anchor, [
    { header: s.title },
    { label: tab ? 'Show' : 'Open', run: () => openSession(s) },
    tab ? { label: 'Close', run: () => closeWithCheck(tab) } : null,
    { icon: 'bookmark', label: isPinned ? 'Unpin' : 'Pin to the top', hint: 'P', run: () => togglePin(s) },
    { icon: 'archive', label: isArchived ? 'Unarchive' : 'Archive', hint: 'A', run: () => toggleArchive(s) },
    { label: 'Rename…', hint: 'F2', run: () => renameConversation(s) },
    { label: 'New conversation in this project', run: () => newSession(s.cwdDisplay || s.cwd) },
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
  if (e.key.toLowerCase() === 'a' && !e.shiftKey) return e.preventDefault(), toggleArchive(s);
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') return e.preventDefault(), rowMenu(s, e.currentTarget);
}

function sessionRow(s, where) {
  const tab = tabForSession(s);
  const cur = !!tab && tab.id === S.active;
  const isPinned = pinned().includes(s.path);
  const isArchived = archived().includes(s.path);
  const pin = iconBtn('bookmark', isPinned ? 'Unpin' : 'Pin to the top', () => togglePin(s), 'sm' + (isPinned ? ' on' : ''));
  const arch = iconBtn('archive', isArchived ? 'Unarchive' : 'Archive', () => toggleArchive(s), 'sm' + (isArchived ? ' on' : ''));
  const more = iconBtn('more', 'More', (e) => rowMenu(s, e.currentTarget), 'sm');
  return h('div', { class: 's-row' + (cur ? ' cur' : '') + (tab?.streaming ? ' live' : '') + (tab?.unread && !cur ? ' unread' : '') + (isArchived ? ' archived' : '') },
    h('button', { class: 's-btn', type: 'button', dataset: { path: s.path }, 'aria-label': s.title, title: s.title, 'aria-current': cur ? 'page' : null, onclick: () => openSession(s), ondblclick: (e) => (e.preventDefault(), renameConversation(s)), onkeydown: (e) => rowKeys(s, e), oncontextmenu: (e) => (e.preventDefault(), rowMenu(s, e.currentTarget)) },
      stateDot(tab),
      s.branch ? icon('branch', 12, 's-br') : null,
      s.agent ? h('span', { class: 's-agent', title: `Runs on ${agentOf(s.agent)?.name || s.agent}` }, brandMark(s.agent, 12)) : null,
      h('span', { class: 'ell grow' }, s.title),
      working(tab) ? dotGrid('s-live') : tab && dotState(tab) === 'warn' ? h('span', { class: 's-you' }, 'Needs you') : where ? h('span', { class: 's-where ell' }, where) : h('span', { class: 's-when num' }, timeAgo(s.mtime))),
    h('span', { class: 'row-acts' }, pin, arch, more));
}

/** A project's menu (its ⋯ button or a right-click on its name). */
function projectMenu(g, anchor) {
  const all = groupSessions();
  projectPopover(g.path, anchor, [
    { icon: 'plus', label: 'New conversation here', run: () => newSession(g.path) },
    { icon: 'chevron-up', label: 'Fold the other projects', run: () => {
      for (const x of all) if (x.key !== g.key) collapsed.add(x.key);
      collapsed.delete(g.key);
      lsSet('collapsed', [...collapsed]);
      drawSidebar();
    } },
    { icon: 'chevron-down', label: 'Unfold all projects', run: () => {
      collapsed.clear();
      lsSet('collapsed', []);
      drawSidebar();
    } },
    g.saved ? { icon: 'x', label: 'Remove from the list (files kept)', run: async () => {
      try {
        S.workspaces = (await api.post('/api/workspaces/remove', { id: g.id })).workspaces;
        drawSidebar();
      } catch (e) {
        toast(e.message, 'error');
      }
    } } : null,
  ].filter(Boolean));
}

/** Pinned conversations, above the projects. */
function pinnedList(term) {
  const by = new Map(S.sessions.map((x) => [x.path, x]));
  const list = pinned().map((p) => by.get(p)).filter(Boolean).filter((x) => !term || `${x.title} ${x.preview || ''}`.toLowerCase().includes(term));
  if (!list.length) return null;
  return h('div', { class: 'pin-sec' }, h('div', { class: 'side-h' }, h('span', null, 'Pinned')), list.map((x) => sessionRow(x, baseName(x.cwdDisplay || x.cwd))));
}

/** Arrow keys move between the rows of the sidebar list; Home and End go to the ends. */
// The list is one tab stop (roving tabindex): Tab reaches the current row, arrows move between rows, and each row's
// own buttons (pin, archive, more, new here) are reached with its keys and its menu instead of more Tab stops.
const listRows = () => [...sideEl.querySelectorAll('.side-scroll .run-row, .side-scroll .proj-btn, .side-scroll .s-btn, .side-scroll .s-more')].filter((x) => x.getClientRects().length);
function rove(to) {
  for (const r of sideEl.querySelectorAll('.side-scroll [data-rove="0"]')) if (r !== to) (r.tabIndex = -1), (r.dataset.rove = '-1');
  if (to) (to.tabIndex = 0), (to.dataset.rove = '0');
}
function setupRoving() {
  const rows = listRows();
  for (const r of rows) (r.tabIndex = -1), (r.dataset.rove = '-1');
  for (const b of sideEl.querySelectorAll('.side-scroll .row-acts button')) b.tabIndex = -1;
  rove(rows.find((r) => r.getAttribute('aria-current') === 'page') || rows[0]);
}
function listKeys(e) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey) return;
  const rows = listRows();
  const i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  rove(rows[n]);
  rows[n].focus();
}

/**
 * What the sidebar shows, as one string. Status events arrive many times a minute while agents work; rebuilding on
 * each one dropped the hover, the keyboard focus and any open row menu, so it is rebuilt only when this changes.
 */
// ---- project facts for the sidebar: its git branch (a quiet chip), read in the background and kept a minute ----
const infoOf = new Map(); // path -> { at, branch }
function projInfo(path) {
  const hit = infoOf.get(path);
  if (!hit || Date.now() - hit.at > 60000) {
    infoOf.set(path, { at: Date.now(), branch: hit?.branch || '' });
    loadInfo(path).then((info) => {
      const branch = info?.repo ? info.branch || '' : '';
      if (branch !== (hit?.branch || '')) {
        infoOf.set(path, { at: Date.now(), branch });
        drawSidebar();
      }
    }, () => {});
  }
  return infoOf.get(path);
}
/** The most urgent state of a project's open conversations, for its tile on the rail: warn, run, unread or ''. */
function projState(g) {
  const tabs = [...S.tabs.values()].filter((t) => !t.dead && keyPath(t.worktree?.source || t.workspace || '') === g.key);
  for (const st of ['warn', 'run', 'unread']) if (tabs.some((t) => dotState(t) === st && t.id !== S.active)) return st;
  return '';
}

let sideSig = '';
function sidebarSig() {
  return JSON.stringify([
    searchTerm, filterOpen, [...collapsed], [...expanded], pinned(), archived(), S.ui.sortProjects || '', S.ui.showArchived === true, showRunningSection(), S.active, Math.floor(Date.now() / 60000),
    hubView()?.view || '', reviewCount(), workingCount(),
    S.sessions.map((s) => [s.path, s.mtime, s.title]),
    [...S.tabs.values()].map((t) => [t.id, t.name, t.workspace, !!t.streaming, !!t.dead, !!t.unread, t.dialogs.some(isApproval), t.resume || '', t.state?.sessionId || '', t.worktree?.branch || '', t.worktree?.state || '']),
    S.workspaces.map((w) => [w.id, w.path, w.name]),
    (S.engine?.providers || []).filter((p) => p.configured).map((p) => p.name),
    S.update ? [S.update.state, S.update.version, S.update.percent] : null,
    week ? week.days.map((d) => dayTokens(d) + d.prompts * 7 + d.workMs) : null,
    [...infoOf].map(([k, v]) => k + v.branch), S.ui.sideRail === true, navigator.onLine, S.ui.keys || null,
  ]);
}

// ---- This week: one quiet line above Settings ("52k tokens this week"); a click opens the 7 days as a chart ----
// From GET /api/analytics (the server caches each conversation file's sums, so this is cheap); read again every
// five minutes while the sidebar redraws, and opened in full in Settings → Analytics.
function loadWeek() {
  if (Date.now() - weekAt < 5 * 60000) return;
  weekAt = Date.now();
  api.get('/api/analytics?range=7').then((d) => {
    week = d?.days?.length ? d : null;
    drawSidebar();
  }, () => {});
}
const weekTime = (ms) => (ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);
const dayTokens = (d) => d.input + d.output + d.cacheRead + d.cacheWrite;

/** The popover: seven bars on seven faint tracks, so one busy day never reads as a solid block; today in the accent. */
function weekChart() {
  const max = Math.max(1, ...week.days.map(dayTokens));
  const cols = week.days.map((d, i) => {
    const day = new Date(`${d.date}T12:00:00`);
    const full = day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const bar = h('i', { class: i === week.days.length - 1 ? 'today' : '' });
    bar.style.setProperty('--v', `${dayTokens(d) ? Math.max(6, (dayTokens(d) / max) * 100) : 0}%`);
    return h('li', { class: 'wk-col', tabindex: '0', title: `${full}: ${dayTokens(d).toLocaleString()} tokens, ${d.prompts} message${d.prompts === 1 ? '' : 's'}`, 'aria-label': `${full}: ${dayTokens(d).toLocaleString()} tokens` },
      h('span', { class: 'wk-track' }, bar), h('span', { class: 'wk-d' }, day.toLocaleDateString(undefined, { weekday: 'narrow' })));
  });
  const total = week.days.reduce((n, d) => n + dayTokens(d), 0);
  const msgs = week.days.reduce((n, d) => n + d.prompts, 0);
  const work = week.days.reduce((n, d) => n + d.workMs, 0);
  return h('div', { class: 'wk' },
    h('div', { class: 'wk-h' }, h('span', null, 'Last 7 days'), h('b', { class: 'num' }, `${total.toLocaleString()} tokens`)),
    h('ol', { class: 'wk-cols', 'aria-label': 'Tokens per day' }, cols),
    h('div', { class: 'wk-f num' }, `${msgs} message${msgs === 1 ? '' : 's'} · ${work ? `${weekTime(work)} agent time` : 'no agent time'}`),
    h('button', { class: 'link wk-more', type: 'button', onclick: () => (document.querySelector('.pop-panel')?._close?.(), settingsDialog('usage')) }, 'Open Analytics'));
}
function weekLine() {
  if (!week) return null;
  const total = week.days.reduce((n, d) => n + dayTokens(d), 0);
  return h('button', { class: 'side-week', type: 'button', 'aria-haspopup': 'dialog', title: 'Tokens over the last 7 days', onclick: (e) => popover(e.currentTarget, weekChart(), { cls: 'wk-pop', label: 'Tokens over the last 7 days' }) },
    h('span', { class: 'num' }, total ? `${fmtTokens(total)} tokens this week` : 'No tokens this week'));
}

// The sidebar's pages: Runs, and one Customize item for Plugins, Skills, Loops and Review (tabs on its page).
const SIDE_NAV = [
  { view: 'runs', label: 'Runs', icon: 'runs', hint: 'Track work across projects', key: 'runs' },
  { view: 'customize', label: 'Customize', icon: 'customizations', hint: 'Plugins, skills, loops and review' },
];

function drawSidebar() {
  loadWeek();
  const sig = sidebarSig();
  if (sig === sideSig && sideEl.querySelector('.side-scroll')) return;
  sideSig = sig;
  const sortByName = S.ui.sortProjects === 'name';
  const showArchived = S.ui.showArchived === true;
  const hidden = new Set(showArchived ? [] : archived());
  const groups = groupSessions().map((g) => (hidden.size ? { ...g, sessions: g.sessions.filter((x) => !hidden.has(x.path)) } : g));
  if (sortByName) groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const term = searchTerm.toLowerCase().trim();
  // The sidebar is rebuilt on every change; keep the search box focused (with its caret) and the list scroll.
  const focused = document.activeElement;
  const typing = focused?.matches('.side-search input') ? focused.selectionStart : -1;
  const row = focused?.closest('#sidebar .s-row')?.querySelector('.s-btn[data-path]');
  const rowIndex = row ? [...sideEl.querySelectorAll('.s-btn[data-path]')].indexOf(row) : -1;
  const scroll = sideEl.querySelector('.side-scroll')?.scrollTop || 0;
  const search = h('input', { type: 'search', placeholder: 'Filter conversations', value: searchTerm, 'aria-label': 'Filter conversations', spellcheck: 'false', oninput: (e) => ((searchTerm = e.target.value), drawSidebar()), onkeydown: (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') return e.stopPropagation(), (searchTerm = ''), (filterOpen = false), drawSidebar(), sideEl.querySelector('.side-filter-btn')?.focus();
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
    // Working, not waiting for you: a conversation that needs your OK shows in Running, not as work in progress.
    const live = [...S.tabs.values()].filter((t) => !t.dead && t.streaming && !t.dialogs.some(isApproval) && keyPath(t.worktree?.source || t.workspace || '') === g.key).length;
    const toggle = () => {
      collapsed.has(g.key) ? collapsed.delete(g.key) : collapsed.add(g.key);
      lsSet('collapsed', [...collapsed]);
      drawSidebar();
    };
    const info = projInfo(g.path);
    return h('div', { class: 'proj' },
      h('div', { class: 'proj-head' },
        h('button', { class: 'proj-btn', type: 'button', title: live ? `${g.path}\n${live} working` : g.path, 'aria-expanded': String(open), dataset: { state: projState(g) }, onclick: toggle, oncontextmenu: (e) => (e.preventDefault(), projectMenu(g, e.currentTarget)), onkeydown: (e) => ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') && (e.preventDefault(), projectMenu(g, e.currentTarget)) },
          h('span', { class: 'proj-mark' }, projTile(g.name, 20), icon(open ? 'chevron-down' : 'chevron-right', 12, 'chev')), h('span', { class: 'ell proj-name' }, g.name),
          h('span', { class: 'proj-meta' },
            live ? h('span', { class: 'proj-live', title: `${live} working` }, dotGrid(), h('span', { class: 'num' }, live)) : null,
            info?.branch ? h('span', { class: 'proj-br ell', title: `Branch ${info.branch}` }, h('bdi', null, info.branch)) : null)),
        h('span', { class: 'row-acts' },
          iconBtn('plus', `New conversation in ${g.name}`, () => newSession(g.path), 'sm'),
          iconBtn('more', `${g.name}: more`, (e) => projectMenu(g, e.currentTarget), 'sm'))),
      open ? fresh.map((t) => h('div', { class: 's-row' + (t.id === S.active ? ' cur' : '') },
        h('button', { class: 's-btn', type: 'button', title: t.name, 'aria-current': t.id === S.active ? 'page' : null, onclick: () => setActive(t.id) }, stateDot(t), h('span', { class: 'ell grow' }, t.name), working(t) ? dotGrid('s-live') : h('span', { class: 's-when', title: 'Not saved to the list yet' }, 'new')))) : null,
      shown.map((s) => sessionRow(s)),
      open && !term && !sess.length && !fresh.length ? h('div', { class: 's-none' }, g.sessions.length ? 'All pinned' : ['No conversations yet · ', h('button', { class: 'link s-start', type: 'button', onclick: () => newSession(g.path) }, 'Start one')]) : null,
      // The rest of a long project opens in place; it stays open until you fold it again.
      open && !term && sess.length > SHOWN ? h('button', { class: 's-more', type: 'button', 'aria-expanded': String(all), onclick: () => {
        all ? expanded.delete(g.key) : expanded.add(g.key);
        lsSet('expanded', [...expanded]);
        drawSidebar();
      } }, icon(all ? 'chevron-up' : 'chevron-down', 12), all ? 'Show fewer' : `Show ${sess.length - SHOWN} more`) : null);
  }).filter(Boolean);
  sideEl.replaceChildren();
  const showFilter = filterOpen || !!searchTerm;
  const toggleFilter = () => {
    filterOpen = !showFilter;
    if (!filterOpen) searchTerm = '';
    drawSidebar();
    if (filterOpen) sideEl.querySelector('.side-search input')?.focus();
  };
  sideEl.append(
    h('button', { class: 'side-new' + (S.active || isHub() ? '' : ' cur'), type: 'button', title: 'New conversation (Ctrl+N)', 'aria-current': S.active || isHub() ? null : 'page', onclick: () => newSession() }, sideIcon('new'), h('span', { class: 'side-l' }, 'New conversation'), keyHint(firstKey(S.ui.keys, 'new'))),
    h('nav', { class: 'side-nav', 'aria-label': 'Main' },
      h('button', { class: 'side-link side-search-btn', type: 'button', title: `Search conversations (${firstKey(S.ui.keys, 'search') || 'Ctrl+K'})`, onclick: () => openSearch('conversations') }, sideIcon('search'), h('span', { class: 'side-l' }, 'Search'), keyHint(firstKey(S.ui.keys, 'search'))),
      SIDE_NAV.map(({ view, label, hint, key, icon: glyph }) => {
        const cur = view === 'customize' ? isCustomize(hubView()?.view) : hubView()?.view === view || (view === 'runs' && hubView()?.view === 'run');
        const shortcut = key && firstKey(S.ui.keys, key);
        // Runs shows how many are working; Customize carries what waits for you (the Review tab's count).
        const count = view === 'runs' ? workingCount() : reviewCount();
        const status = `${count} ${view === 'runs' ? 'working' : 'waiting for you'}`;
        return h('button', { class: `side-link${cur ? ' cur' : ''}`, type: 'button', title: shortcut ? `${hint} (${shortcut})` : hint, 'aria-current': cur ? 'page' : null, onclick: () => goHub(view === 'customize' ? lastCustomize.view : view) },
          sideIcon(glyph), h('span', { class: 'side-l' }, label), count ? h('span', { class: `side-count num${view === 'runs' ? ' quiet' : ''}`, title: status, 'aria-label': status }, count) : null, keyHint(shortcut));
      })),
    h('div', { class: 'side-scroll', onkeydown: listKeys, onfocusin: (e) => e.target.dataset?.rove === '-1' && rove(e.target) },
      pinnedList(term),
      h('div', { class: 'side-h' }, h('span', null, 'Projects'),
        h('span', { class: 'side-h-acts' },
          iconBtn('filter', 'Filter and sort', (e) => popMenu(e.currentTarget, [
            { icon: 'search', label: showFilter ? 'Close the filter' : 'Filter conversations…', run: toggleFilter },
            '-',
            { header: 'Sort projects' },
            { label: 'By recent activity', on: !sortByName, run: () => savePrefs({ sortProjects: 'recent' }) },
            { label: 'By name', on: sortByName, run: () => savePrefs({ sortProjects: 'name' }) },
            '-',
            { label: `Show archived (${archived().filter((p) => S.sessions.some((x) => x.path === p)).length})`, on: showArchived, run: () => savePrefs({ showArchived: !showArchived }) },
          ], { minWidth: 220 }), 'sm side-filter-btn' + (showFilter || sortByName || showArchived ? ' on' : '')),
          iconBtn('folder-plus', 'Open a project folder', openFolder, 'sm'))),
      showFilter ? h('div', { class: 'side-search' }, icon('search', 14), search) : null,
      projects.length ? projects : term ? h('div', { class: 'side-empty' }, 'No conversations match.') : h('div', { class: 'side-empty' }, h('span', null, 'No projects yet.'), h('button', { class: 'link', type: 'button', onclick: openFolder }, icon('folder-plus', 13), 'Open a folder'))),
    // The agents at work sit in a dock above the footer: one appearing or finishing never moves the list above it.
    runningList() || '',
    weekLine() || '',
    h('div', { class: 'side-foot' },
      h('button', { class: 'side-link foot-set', type: 'button', title: `Settings${firstKey(S.ui.keys, 'settings') ? ` (${firstKey(S.ui.keys, 'settings')})` : ''}`, onclick: () => settingsDialog() }, sideIcon('settings'), h('span', { class: 'side-l' }, 'Settings'), keyHint(firstKey(S.ui.keys, 'settings'))),
      footStatus()),
  );
  sideEl.querySelector('.side-scroll').scrollTop = scroll;
  setupRoving();
  if (typing >= 0) {
    search.focus({ preventScroll: true });
    search.setSelectionRange(typing, typing);
  } else if (row) {
    const rows = [...sideEl.querySelectorAll('.s-btn[data-path]')];
    const next = rows.find((b) => b.dataset.path === row.dataset.path) || rows[Math.min(rowIndex, rows.length - 1)] || sideEl.querySelector('.side-new');
    if (next?.closest('.side-scroll')) rove(next);
    next?.focus({ preventScroll: true });
  }
}

/**
 * The board of agents at the top of the sidebar: sessions working or waiting on you, and every session on its own
 * branch (with its branch) until it is closed. Each says what it is doing: working, needs you or done, and for how long.
 */
function runningList() {
  const live = [...S.tabs.values()].filter(onBoard);
  if (!live.length || !showRunningSection()) return null;
  return h('div', { class: 'run-sec side-dock' },
    h('div', { class: 'side-h' }, h('span', null, 'Running')),
    live.map((t) => {
      const st = boardState(t);
      const waiting = st === 'needs you';
      return h('button', { class: 'run-row' + (t.id === S.active ? ' cur' : '') + (t.worktree ? ' has-branch' : ''), type: 'button', title: `${t.name}\n${t.worktree ? t.worktree.branch + '\n' : ''}${t.workspace}`, dataset: { id: t.id }, onclick: () => setActive(t.id) },
        t.streaming && !waiting ? dotGrid('run-live') : h('span', { class: 'dot' + (waiting ? ' warn' : ' ok') }),
        h('span', { class: 'run-m' }, h('span', { class: 'ell' }, t.name), t.worktree ? h('span', { class: 'run-br ell' }, h('bdi', null, t.worktree.branch)) : null, h('span', { class: 'run-now ell' }, runNow(t, st))),
        h('span', { class: 'run-st num' + (waiting ? ' you' : t.streaming ? '' : ' idle') }, runLabel(t, st)));
    }));
}

const runTime = (t) => fmtElapsed(Math.max(0, Math.floor((Date.now() - (t.turnStartedAt || Date.now())) / 1000)));
/** Right side of a board row: the running time while it works, how long the last turn took once it is done. */
function runLabel(t, st) {
  if (st === 'needs you') return 'Needs you';
  if (st === 'working') return runTime(t);
  const took = t.lastRunMs ? fmtElapsed(Math.max(0, Math.round(t.lastRunMs / 1000))) : '';
  const word = st === 'merged' ? 'Merged' : st === 'kept' ? 'Kept' : 'Done';
  return took ? `${word} · ${took}` : word;
}
function runNow(t, st) {
  if (st === 'needs you') return t.dialogs.find(isApproval)?.title || 'Waiting for your OK';
  if (st !== 'working') return t.worktree && st === 'done' ? 'Ready to review' : st === 'merged' ? `In ${t.worktree?.baseBranch || 'the base branch'}` : 'Idle';
  const now = views.get(t.id)?.nowDoing?.();
  return now ? `${now[0]} ${now[1]}`.trim() : 'Working';
}

// Once a second while visible and working: update the elapsed labels, not the rest of the chrome.
setInterval(() => {
  if (document.hidden || !document.documentElement.classList.contains('agent-busy')) return;
  for (const row of sideEl.querySelectorAll('.run-row[data-id]')) {
    const t = S.tabs.get(row.dataset.id);
    if (!t || t.dead) continue;
    const state = boardState(t);
    const st = row.querySelector('.run-st');
    const now = row.querySelector('.run-now');
    if (st && state === 'working') st.textContent = runTime(t);
    if (now) {
      const text = runNow(t, state);
      if (text !== now.textContent) now.textContent = text;
    }
  }
  tickToolbar(topEl);
}, 1000);
function syncTitle() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  const wait = live.filter((t) => t.dialogs.some(isApproval)).length;
  const run = live.filter((t) => t.streaming).length;
  const title = wait ? `(${wait}) Needs your OK · ORBIX` : run ? `Working (${run}) · ORBIX` : 'ORBIX';
  if (document.title !== title) document.title = title;
}

/** Sidebar footer: whether the agent can work, and with which provider. */
/** The footer's model status: a chip that says what it means, and opens Settings → Providers. */
function footStatus() {
  const all = (S.engine?.providers || []).filter((p) => p.configured);
  const ok = all.filter((p) => !p.signInError);
  const chip = (state, text, title) => h('button', { class: `foot-status ${state}`, type: 'button', title, onclick: () => settingsDialog('engine') }, h('span', { class: `dot ${state}` }), h('span', { class: 'fs-t ell' }, text));
  if (!navigator.onLine) return chip('err', 'Offline', 'This PC is offline. Local models still work.');
  if (all.length && !ok.length) return chip('warn', 'Sign in again', `${all.map((p) => p.name).join(', ')}: the sign-in has ended. Sign in again in Settings → Providers.`);
  if (ok.length && engineReady()) return chip('ok', `${ok.length} provider${ok.length === 1 ? '' : 's'} ready`, `Connected: ${ok.map((p) => p.name.replace(/ \(.*\)$/, '')).join(', ')}`);
  return chip('warn', 'No model connected', 'Add an API key, a sign-in or a local model');
}
addEventListener('online', () => drawSidebar());
addEventListener('offline', () => drawSidebar());

function toggleTheme() {
  savePrefs({ theme: document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark' });
}

/** Show the home composer (optionally for one project). Open tabs stay open. */
let homeRequested = false;
/** Open Runs, Review, or one run. The open conversation stays in its tab. */
function goHub(view, id) {
  homeRequested = true;
  if (narrowSide.matches) overlay.side = false;
  // Open the hub first, so leaving the conversation lands on it directly (back and forward see one step).
  openHub(view, id);
  if (S.active) setActive(null);
}

function newSession(project, opts) {
  homeRequested = true;
  closeHub(true);
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

// Saved conversations being opened (path -> promise): a second click (a double-click) waits for the first open
// instead of starting a second agent on the same file.
const opening = new Map();
function openSession(s) {
  const existing = tabForSession(s);
  if (narrowSide.matches && overlay.side) (overlay.side = false), applyPrefs();
  if (existing) return setActive(existing.id);
  if (opening.has(s.path)) return opening.get(s.path);
  const p = openSaved(s).finally(() => opening.delete(s.path));
  opening.set(s.path, p);
  return p;
}
async function openSaved(s) {
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
  if (t.streaming && askBeforeClose() && !(await confirmDialog('Close conversation', 'The agent is still working. Stop it and close this conversation?', { ok: 'Stop and close', danger: true }))) return;
  closeTab(t.id);
}

async function renameTab(t) {
  const n = cleanName(await promptDialog('Rename conversation', 'Name', t.name));
  // Same text as shown is still saved when the shown name is only the automatic one (nothing was saved yet).
  if (!n || (n === t.name && cleanName(t.title) === n)) return;
  try {
    if (t.dead) {
      // Its agent has stopped: rename the saved file instead (nothing was saved yet: only the tab has a name).
      const s = S.sessions.find((x) => (t.state?.sessionId && x.id === t.state.sessionId) || (t.resume && x.path === t.resume));
      if (s) await api.post('/api/sessions/rename', { path: s.path, title: n });
      t.title = n;
      emit('tabs');
      if (s) await loadSessions();
      return;
    }
    await renameSession(t, n);
  } catch (e) {
    toast(`Could not rename: ${e.message}`, 'error');
  }
}

/** The project crumb in the toolbar: a new conversation there, show the folder, copy its path. */
function projectCrumbMenu(t, anchor) {
  projectPopover(t.workspace, anchor, [{ icon: 'plus', label: 'New conversation in this project', run: () => newSession(t.workspace) }]);
}

/** The toolbar follows the view; it redraws only when what it shows changed. */
function drawTop() {
  drawToolbar(topEl);
}

/** Text size of the conversation (Appearance → Message text size): +1, -1, or 0 to reset. */
function textSize(d) {
  const cur = S.ui.fontSize || 14;
  const next = d === 0 ? 14 : Math.max(12, Math.min(18, cur + d));
  if (next !== cur) savePrefs({ fontSize: next });
  toast(next === cur && d !== 0 ? `Text size is at its ${next === 18 ? 'largest' : 'smallest'} (${next}px)` : `Text size ${next}px`, 'info', 1400);
}
/** The next or previous open conversation (Ctrl+Tab, Ctrl+Shift+Tab). */
function cycle(dir) {
  const list = [...S.tabs.values()];
  if (!list.length) return;
  const i = list.findIndex((t) => t.id === S.active);
  setActive(list[i < 0 ? (dir < 0 ? list.length - 1 : 0) : (i + dir + list.length) % list.length].id);
}
/** Where back and forward go: a conversation, Runs or Review, or Home. */
function goTo(loc) {
  if (loc.kind === 'tab') return setActive(loc.id);
  if (loc.kind === 'hub') return goHub(loc.view, loc.id);
  homeRequested = true;
  closeHub(true);
  if (S.active) setActive(null);
  else showActive();
}

Object.assign(shell, {
  newSession, openFolder, goHub, goTo, connect: () => openConnect(), settings: (tab) => settingsDialog(tab), help: openHelp, shortcuts: () => settingsDialog('keys'), diagnostics: openDiagnostics,
  manage: openCleanup, search: () => openSearch(), toggleSidebar, togglePanel, sideShown, panelShown, toggleTerminal, terminalShown, togglePanelMax, panelMax, toggleTheme, textSize, cycle,
  zen: () => toggleZen(), wide: toggleWide, hubView, workingCount, open: (id) => setActive(id), close: (t) => closeWithCheck(t), rename: (t) => renameTab(t),
  projectMenu: projectCrumbMenu,
  sessionMenu: (t, anchor) => {
    const s = S.sessions.find((x) => tabForSession(x) === t);
    sessionMenu(t, anchor, { rename: () => renameTab(t), close: () => closeWithCheck(t), find: () => viewOf(t)?.bar.openFind(), outline: () => viewOf(t)?.bar.openOutline(), inspect: () => showTab('run'), pin: s ? { on: pinned().includes(s.path), run: () => togglePin(s) } : null, move: t.noSession ? null : () => moveToMachine(t) });
  },
});
on('chrome', () => {
  drawTop();
  drawMenubar(menuEl);
});
on('git', () => drawTop());
on('search', (scope) => openSearch(scope));
on('open-run', (id) => goHub(id ? 'run' : 'runs', id || undefined));
on('open-tab', (id) => S.tabs.has(id) && setActive(id));
on('open-session', (s) => s && openSession(s));
on('feedback', (draft) => openFeedback(draft));
// Links in replies open where Settings → Browser says: the Browser tab beside the conversation, or your own browser.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
  if (!/^https?:/i.test(a.href) || !a.closest('#session, #panel, #runs') || browserPrefs().openLinks !== 'builtin') return;
  if (!activeTab() || !canShowInside(a.href)) return;
  e.preventDefault();
  emit('browse', a.href);
});

const homeHandlers = {
  search: openSearch,
  connect: () => openConnect(),
  openFolder,
  openSession,
  settings: (tab) => settingsDialog(tab),
  manage: openCleanup,
  diagnostics: openDiagnostics,
};
const drawWelcome = () => drawHome(homeEl, homeHandlers);

/**
 * Settings → Appearance → Conversations as tabs: the open conversations in a row under the toolbar, like a browser's
 * tabs. A working one shows the dot grid, one that needs you a dot; × or a middle click closes it.
 */
let stripSig = '';
function drawTabStrip() {
  const on = S.ui.topTabs === true && S.tabs.size > 0;
  const sig = on ? JSON.stringify([S.active, [...S.tabs.values()].map((t) => [t.id, t.name, !!t.streaming, !!t.dead, t.dialogs.some(isApproval), !!t.unread])]) : '';
  if (sig === stripSig) return;
  stripSig = sig;
  stripEl.hidden = !on;
  if (!on) return stripEl.replaceChildren();
  stripEl.replaceChildren(...[...S.tabs.values()].map((t) => {
    const cur = t.id === S.active;
    const wait = t.dialogs.some(isApproval);
    const mark = t.streaming && !t.dead && !wait ? dotGrid() : h('span', { class: `dot ${t.dead ? 'dead' : wait ? 'warn' : t.unread ? 'unread' : 'idle'}` });
    return h('div', { class: 'ts-tab' + (cur ? ' cur' : ''), role: 'presentation' },
      h('button', { class: 'ts-btn', type: 'button', role: 'tab', 'aria-selected': String(cur), title: t.name, onclick: () => setActive(t.id), onauxclick: (e) => e.button === 1 && (e.preventDefault(), closeWithCheck(t)) }, mark, h('span', { class: 'ell' }, t.name)),
      iconBtn('x', `Close ${t.name}`, () => closeWithCheck(t), 'sm ts-x'));
  }), iconBtn('plus', 'New conversation', () => newSession(), 'sm ts-new'));
}
for (const event of ['tabs', 'active', 'tab:status', 'tab:state', 'tab:dialog', 'prefs']) on(event, () => drawTabStrip());
function viewFor(tab) {
  let v = views.get(tab.id);
  if (!v) {
    v = new TabView(tab);
    views.set(tab.id, v);
  }
  return v;
}

/** The view that just came on screen settles in (a short fade and rise), once per change of view, not per redraw. */
let shownKey = '';
function settleIn(el, key) {
  if (key === shownKey) return;
  const first = !shownKey;
  shownKey = key;
  if (first || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.classList.remove('v-in');
  void el.offsetWidth; // restart the animation
  el.classList.add('v-in');
}

function showActive() {
  const t = activeTab();
  const hub = !t && isHub() && hubView();
  navRecord(t ? { kind: 'tab', id: t.id } : hub ? { kind: 'hub', view: hub.view, id: hub.id } : { kind: 'home' });
  queueMicrotask(() => settleIn(t ? sessEl : hub ? runsEl : homeEl, t ? `tab:${t.id}` : hub ? `hub:${hub.view}:${hub.id || ''}` : 'home'));
  applyPrefs();
  drawTop();
  drawSidebar();
  for (const id of [...views.keys()]) {
    if (S.tabs.has(id)) continue;
    views.get(id)?.destroy?.();
    views.delete(id);
  }
  runsEl.hidden = !isHub() || !!t;
  if (isHub() && !t) {
    if (!sessEl.hidden) sessEl.firstChild?._view?.detach();
    sessEl.hidden = true;
    sessEl.replaceChildren();
    homeEl.hidden = true;
    drawHub();
    syncExtDialogs(null);
    return;
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
on('active', (t) => t && closeHub(true)); // choosing a conversation leaves Runs and Review
on('active', showActive);
on('hub', showActive);
on('runs', () => drawSidebar());
on('update', () => drawSidebar());
on('engine', () => {
  for (const v of views.values()) v.permBtn?.update(v.tab.dead);
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
  if (t && ('showThinking' in patch || 'timeFormat' in patch)) views.get(t.id)?.renderAll();
  if (t && ('whileBusy' in patch || 'sendKey' in patch || 'effortDisplay' in patch)) views.get(t.id)?.updateComposer();
});
const viewOf = (tab) => views.get(tab.id);
// Focus mode only makes sense on a conversation: going Home leaves it.
on('active', () => !activeTab() && zenOn() && toggleZen(false));
on('tab:messages', (tab, d) => {
  const v = viewOf(tab);
  if (!v) return;
  if (d.type === 'reset') v.renderAll();
  else if (d.type === 'remove') v.removeMsg(d.msg);
  else v.appendMsg(d.msg);
  if (d.msg?.role === 'user') drawTop();
});
on('tab:live', (tab) => viewOf(tab)?.renderLive());
on('tab:turn-ended', (tab) => viewOf(tab)?.refreshActs());
on('tab:tool', (tab, id) => viewOf(tab)?.updateTool(id));
// The mark in the toolbar speeds up its orbit while any session is working.
const syncBusy = () => {
  document.documentElement.classList.toggle('agent-busy', [...S.tabs.values()].some((t) => t.streaming && !t.dead));
};
on('tab:state', (tab) => (viewOf(tab)?.updateComposer(), syncBusy()));
on('tabs', () => { syncBusy(); syncTitle(); });
on('tab:status', (tab) => {
  const v = viewOf(tab);
  v?.updateComposer();
  syncBusy();
  syncTitle();
  if (tab.dead && v && !v.deadShown) v.showDead();
  drawTop();
  drawSidebar();
  if (!activeTab()) drawWelcome(); // Home shows working / waiting states
});
on('tab:editor', (tab) => viewOf(tab)?.setText(tab.draft));
on('tab:dialog', (tab) => {
  if (tab === activeTab()) drawTop(); // "Needs your OK" in the toolbar the moment an approval arrives, not "Working"
  syncTitle();
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
  } else if (!t && !isHub()) insertHome(text);
});
on('settings', (tab) => settingsDialog(tab));
on('open-plugins', (tab) => {
  selectPluginsTab(tab);
  goHub('customizations');
});
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
on('use-skill', (project, name) => {
  newSession(project);
  insertHome(`/skill:${name} `);
});

function paletteItems() {
  const t = activeTab();
  const dark = document.documentElement.dataset.mode === 'dark';
  const items = [
    { group: 'General', icon: 'plus', label: 'New conversation', key: firstKey(S.ui.keys, 'new'), run: () => newSession() },
    ...HUB_LINKS.map(({ view, label, icon, hint, key }) => ({ group: 'General', icon, label, hint, key: key ? firstKey(S.ui.keys, key) : undefined, run: () => goHub(view) })),
    { group: 'General', icon: 'plus', label: 'New conversation without saving it', run: () => newSession(undefined, { ephemeral: true }) },
    { group: 'General', icon: 'folder-plus', label: 'Open project folder…', run: openFolder },
    { group: 'General', icon: 'cog', label: 'Settings', key: firstKey(S.ui.keys, 'settings'), run: () => settingsDialog() },
    { group: 'General', icon: 'plug', label: 'Connect a provider or agent…', key: firstKey(S.ui.keys, 'connect'), run: () => openConnect() },
    { group: 'General', icon: 'key', label: 'Providers', run: () => settingsDialog('engine') },
    { group: 'General', icon: 'trash', label: 'Manage conversations…', run: openCleanup },
    { group: 'General', icon: 'activity', label: 'Diagnostics', run: openDiagnostics },
    { group: 'General', icon: 'compass', label: 'How ORBIX works', run: openHelp },
    { group: 'General', icon: 'keyboard', label: 'Keyboard shortcuts', key: firstKey(S.ui.keys, 'shortcuts'), run: () => settingsDialog('keys') },
    { group: 'View', icon: dark ? 'sun' : 'moon', label: dark ? 'Light theme' : 'Dark theme', run: toggleTheme },
    { group: 'View', icon: 'panel-left', label: 'Toggle sidebar', key: firstKey(S.ui.keys, 'sidebar'), run: toggleSidebar },
  ];
  if (t) {
    items.push({ group: 'View', icon: 'panel-right', label: 'Toggle side panel', key: firstKey(S.ui.keys, 'panel'), run: togglePanel });
    items.push({ group: 'View', icon: 'eye', label: zenOn() ? 'Leave focus mode' : 'Focus mode', key: firstKey(S.ui.keys, 'zen'), run: () => toggleZen() }, { group: 'View', icon: 'wrap', label: 'Toggle wide reading column', run: toggleWide }, { group: 'Conversation', icon: 'search', label: 'Find in conversation', key: 'Ctrl+F', run: () => viewOf(t)?.bar.openFind() }, { group: 'Conversation', icon: 'list', label: 'Jump to one of your messages…', key: 'Ctrl+Shift+O', run: () => viewOf(t)?.bar.openOutline() });
    for (const [k, l, ic] of [['changes', 'Changes', 'branch'], ['files', 'Files', 'folder'], ['console', 'Terminal', 'terminal'], ['browser', 'Browser', 'globe'], ['todos', 'Tasks', 'list'], ['run', 'Inspect', 'activity']]) items.push({ group: 'View', icon: ic, label: `Show ${l}`, run: () => showTab(k) });
    items.push({ group: 'Conversation', icon: 'pencil', label: 'Rename conversation…', run: () => renameTab(t) }, { group: 'Conversation', icon: 'copy', label: 'Copy conversation as Markdown', run: () => copyConversation(t) }, { group: 'Conversation', icon: 'x', label: 'Close conversation', run: () => closeWithCheck(t) });
    for (const c of t.commands) items.push({ group: 'Slash commands', icon: 'command', label: `/${c.name}`, hint: c.description, run: () => emit('insert', `/${c.name} `) });
  }
  // Every saved conversation, searchable by its title and by its first message.
  for (const s of S.sessions) items.push({ group: 'Conversations', scope: 'conversations', icon: 'message', label: s.title, hint: `${baseName(s.cwdDisplay || s.cwd)} · ${timeAgo(s.mtime)}`, text: s.preview, run: () => openSession(s) });
  for (const g of groupSessions().filter((x) => x.path)) items.push({ group: 'Projects', scope: 'projects', icon: 'folder', label: g.name, hint: `${g.sessions.length} conversation${g.sessions.length === 1 ? '' : 's'} · ${g.path}`, run: () => newSession(g.path) });
  items.push(...settingsSearchItems());
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

/** What each changeable shortcut does (keys.mjs has their keys; Settings → Shortcuts changes them). */
const ACTION_RUN = {
  search: () => openSearch(),
  files: () => openSearch(activeTab()?.workspace ? 'files' : undefined),
  new: () => newSession(),
  runs: () => goHub('runs'),
  review: () => goHub('review'),
  automations: () => goHub('automations'),
  back: () => navGo(-1),
  forward: () => navGo(1),
  nextConv: () => cycle(1),
  prevConv: () => cycle(-1),
  sidebar: () => toggleSidebar(),
  panel: () => togglePanel(),
  terminal: () => toggleTerminal(),
  nextPanelTab: () => stepPanelTab(1),
  prevPanelTab: () => stepPanelTab(-1),
  shortcuts: () => settingsDialog('keys'),
  settings: () => settingsDialog(),
  connect: () => openConnect(),
  mcpMenu: () => document.querySelector('#topbar .tb-cx')?.click(),
  focusInput: () => (activeTab() ? viewOf(activeTab())?.focus() : homeEl.querySelector('textarea')?.focus()),
  find: () => viewOf(activeTab())?.bar.openFind(),
  outline: () => viewOf(activeTab())?.bar.openOutline(),
  prevMine: () => viewOf(activeTab())?.timeline?.stepYou(-1),
  nextMine: () => viewOf(activeTab())?.timeline?.stepYou(1),
  sideQuestion: () => openSurface('sideQuestion'),
  inspector: () => openSurface('inspector'),
  surfReview: () => openSurface('surfReview'),
  surfBrowser: () => openSurface('surfBrowser'),
  surfIncognito: () => openSurface('surfIncognito'),
  surfDevice: () => openSurface('surfDevice'),
  surfFiles: () => openSurface('surfFiles'),
  surfChanges: () => openSurface('surfChanges'),
  surfTasks: () => openSurface('surfTasks'),
  surfContext: () => openSurface('surfContext'),
  zen: () => toggleZen(),
  textBigger: () => textSize(1),
  textSmaller: () => textSize(-1),
  textReset: () => textSize(0),
};
// Actions that belong to an open conversation, and ones that wait while a dialog is open; otherwise the key does
// what it would do anyway (Ctrl+F finds in the page on Home, for example).
const NEEDS_TAB = new Set(['nextPanelTab', 'prevPanelTab', 'find', 'outline', 'prevMine', 'nextMine', 'zen']);
const NO_DIALOG = new Set(['find', 'outline', 'prevMine', 'nextMine', 'inspector', 'zen', 'nextPanelTab', 'prevPanelTab']);
// In a terminal the keys belong to the shell, except the ones that show or hide the terminal and the panel, and the
// Ctrl+Alt ones that open a side panel surface.
const IN_TERMINAL = new Set(['terminal', 'panel', 'sideQuestion', 'inspector', 'surfReview', 'surfBrowser', 'surfIncognito', 'surfDevice', 'surfFiles', 'surfChanges', 'surfTasks', 'surfContext']);
const canRun = (a, e) => {
  if (e.target.closest?.('.xterm') && !IN_TERMINAL.has(a.id)) return false;
  if (a.field === false && e.target.closest?.('input, textarea, select, [contenteditable]')) return false;
  if (e.target.closest?.('.menu')) return false;
  if (NEEDS_TAB.has(a.id) && !activeTab()) return false;
  if (NO_DIALOG.has(a.id) && document.querySelector('.scrim')) return false;
  if ((a.id === 'prevMine' || a.id === 'nextMine') && !viewOf(activeTab())?.timeline) return false;
  return true;
};

// Hold Ctrl for a moment: every control that has a shortcut shows its keys beside it; any other key or letting go
// hides them (so a quick Ctrl+K never flashes them).
const KEY_SPOTS = [
  ['#sidebar .side-new', 'new'], ['#sidebar .side-search-btn', 'search'], ['#sidebar .foot-set', 'settings'],
  ['#topbar .tb-side', 'sidebar'], ['#topbar .tb-panel', 'panel'], ['#topbar .tb-search', 'search'],
  [['#sidebar .side-link', 'Runs'], 'runs'], [['.cust-tab', 'Review'], 'review'], [['.cust-tab', 'Loops'], 'automations'],
  ['.ptabs .ptab[aria-label="Terminal"]', 'terminal'], ['.ptabs .ptab[aria-label="Browser"]', 'surfBrowser'], ['.ptabs .ptab[aria-label="Files"]', 'surfFiles'], ['.ptabs .ptab[aria-label="Changes"]', 'surfChanges'], ['.ptabs .ptab[aria-label="Context"]', 'surfContext'],
];
let keyHintTimer = 0;
const hideKeyHints = () => {
  clearTimeout(keyHintTimer);
  if (!document.documentElement.classList.contains('show-keys')) return;
  document.documentElement.classList.remove('show-keys');
  for (const el of document.querySelectorAll('[data-kbd]')) el.removeAttribute('data-kbd');
};
const showKeyHints = () => {
  for (const [sel, id] of KEY_SPOTS) {
    const key = firstKey(S.ui.keys, id);
    if (!key) continue;
    const els = Array.isArray(sel) ? [...document.querySelectorAll(sel[0])].filter((x) => x.textContent.trim().startsWith(sel[1])) : [...document.querySelectorAll(sel)];
    for (const el of els) if (el.getClientRects().length) el.setAttribute('data-kbd', key.replace(/\+/g, ' + '));
  }
  document.documentElement.classList.add('show-keys');
};
addEventListener('keydown', (e) => {
  if (e.key === 'Control' && !e.repeat && !e.altKey && !e.shiftKey) {
    clearTimeout(keyHintTimer);
    keyHintTimer = setTimeout(showKeyHints, 600);
  } else if (e.key !== 'Control') hideKeyHints();
}, true);
addEventListener('keyup', (e) => e.key === 'Control' && hideKeyHints(), true);
for (const ev of ['blur', 'pointerdown']) addEventListener(ev, hideKeyHints, true);

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // Shortcuts you can change: the first action whose keys match. Some wait while you type in a text field. AltGr
  // (Ctrl+Alt to Windows) types characters on many layouts (ś, €, @), so it never runs a Ctrl+Alt shortcut.
  const altGr = e.getModifierState?.('AltGraph');
  const action = !e.defaultPrevented && !altGr && actionFor(comboOf(e), S.ui.keys);
  if (action && canRun(action, e)) {
    e.preventDefault();
    ACTION_RUN[action.id]?.();
    return;
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
});

const banner = $('#banner');
const setBanner = (msg) => {
  banner.hidden = !msg;
  banner.textContent = msg || '';
};

/** Open a tab for every running session this window does not show yet. Returns the ids it just loaded. */
async function adoptRunning(procs, { quiet = false } = {}) {
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
  if (!quiet && !S.active && S.tabs.size && !homeRequested) setActive([...S.tabs.keys()][0]);
  else emit('tabs');
  return fresh;
}

/**
 * Once, on the first start of 3.8: the chat-first layout (side panel closed until you open it, a narrower sidebar).
 * A sidebar width you dragged yourself is kept; the old defaults (264 or 292) are not.
 */
function layoutOnce() {
  if ((S.ui.layout || 0) >= 2) return;
  const w = S.ui.sidebarW;
  const patch = { layout: 2, rightPanel: false, ...(w === 264 || w === 292 || !w ? { sidebarW: SIDE_W } : {}) };
  Object.assign(S.ui, patch); // before anything is drawn, so no redraw is needed
  api.post('/api/prefs', { ui: patch }).catch(() => {});
}

async function boot() {
  initInterface();
  try {
    await loadEnv({ notify: false });
  } catch (e) {
    setBanner(e.message);
    return;
  }
  layoutOnce();
  applyPrefs();
  // The saved layout lands without animating; from here on the sidebar slides and resizes smoothly.
  requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('still')));
  drawMenubar(menuEl);
  drawSidebar();
  drawTop();
  drawWelcome();
  mountPanel($('#panel'));
  mountTerminal({ close: () => panelShown() && togglePanel() });
  bindHoverCards(sideEl, (path) => {
    const s = S.sessions.find((x) => x.path === path);
    if (!s) return null;
    const t = tabForSession(s);
    const st = t && (t.dead ? null : t.dialogs.some(isApproval) ? ['warn', 'Action required'] : t.streaming ? ['run', 'Working'] : t.unread ? ['unread', 'Unread'] : null);
    return { title: s.title, project: baseName(s.cwdDisplay || s.cwd) || s.cwdDisplay || s.cwd, branch: s.branch, updated: updatedLabel(s.mtime), state: st, preview: s.preview && s.preview !== s.title ? s.preview.slice(0, 160) : '' };
  });
  initNotify();
  initBackdrop();
  // Settings → About in the Windows app: the tray, and keeping the PC awake while an agent works.
  const sys = window.orbixDesktop?.system;
  if (sys) {
    let tray = null;
    let awake = null;
    let lastWork = 0;
    // Settings → About → Keep awake: off, while agents work (and 10 minutes after), or always with the screen on.
    const syncSystem = () => {
      if ((S.ui.tray === true) !== tray) sys.tray((tray = S.ui.tray === true));
      const mode = keepAwakeMode();
      const busy = [...S.tabs.values()].some((t) => t.streaming && !t.dead) || workingCount() > 0;
      if (busy) lastWork = Date.now();
      const want = mode === 'always' ? 'screen' : mode === 'work' && (busy || Date.now() - lastWork < 10 * 60000) ? 'work' : '';
      if (want !== awake) sys.keepAwake((awake = want));
    };
    for (const event of ['prefs', 'tabs', 'tab:state', 'tab:status', 'runs']) on(event, syncSystem);
    setInterval(syncSystem, 60000); // the 10 minutes after work end even when nothing else happens
    syncSystem();
  }
  // The Windows app's built-in browser: where downloads go, and a note when one is saved.
  desktopBrowser()?.configure({ downloads: browserPrefs().downloads });
  desktopBrowser()?.onDownload((d) => toast(d.state === 'completed' ? `Downloaded ${d.name}` : `Download ${d.state === 'cancelled' ? 'cancelled' : 'failed'}: ${d.name}`, d.state === 'completed' ? 'ok' : 'error', 3500));
  initRuns({ openProc: async (p) => (await adoptRunning([p]), setActive(p.id)) });
  loadSessions();
  connectEvents({
    onEvent: routeEvent,
    onGlobal: async (g) => {
      if (g.g === 'hello') onHello(g.procs, await adoptRunning(g.procs));
      else if (g.g === 'procs') {
        onProcs(g.procs);
        // An automation started a conversation: it joins the sidebar (Running) without taking the screen.
        const fresh = g.procs.filter((p) => p.automation && !S.tabs.has(p.id));
        if (fresh.length) adoptRunning(fresh, { quiet: true });
        if (hubView()?.view === 'automations') refreshAutomations();
      }
      else if (g.g === 'run' || g.g === 'run_removed') onRunEvent(g);
      else if (g.g === 'sessions') loadSessions();
      else if (g.g === 'pty') emit('pty', g);
      else if (g.g === 'engine' && g.engine) {
        S.engine = g.engine;
        emit('engine');
      }
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
