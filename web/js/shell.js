// The window chrome, laid out like a desktop app: a menu row (ORBIX, Workspace, View, Window; in the Windows app the
// window buttons sit at its right end), then the toolbar: the mark, the sidebar switch, back and forward, search, and
// where you are (project / conversation, with its state and branch); on the right the conversation's menu, the
// Overview card and the side panel. Also here: the Overview card itself, back/forward history across conversations
// and views, and the card that previews a conversation when you rest the pointer on it in the sidebar.
// main.js owns the actions and passes them in through `H`.
import { h, icon, iconBtn, logo, baseName, fmtElapsed, timeAgo } from './dom.js';
import { S, on, emit, activeTab, savePrefs } from './store.js';
import { popMenu, isApproval } from './dialogs.js';
import { gitState, panelInfo, showTab } from './panels.js';

/** Actions, set by main.js. */
export const H = {};

// ================= history =================

const hist = { list: [], at: -1, moving: false };
const keyOf = (loc) => JSON.stringify([loc.kind, loc.id || '', loc.view || '']);
const alive = (loc) => loc.kind !== 'tab' || S.tabs.has(loc.id);

/** Record where you are now (called on every change of view). Back and forward never record. */
export function navRecord(loc) {
  if (hist.moving) return;
  const key = keyOf(loc);
  if (hist.list[hist.at] && keyOf(hist.list[hist.at]) === key) return;
  hist.list = hist.list.slice(0, hist.at + 1).filter(alive);
  hist.list.push(loc);
  if (hist.list.length > 60) hist.list.shift();
  hist.at = hist.list.length - 1;
}
const step = (dir) => {
  for (let i = hist.at + dir; i >= 0 && i < hist.list.length; i += dir) if (alive(hist.list[i])) return i;
  return -1;
};
export const canGo = (dir) => step(dir) >= 0;
export function navGo(dir) {
  const i = step(dir);
  if (i < 0) return;
  hist.at = i;
  hist.moving = true;
  try {
    H.goTo(hist.list[i]);
  } finally {
    hist.moving = false;
  }
}

// ================= menu row =================

let menuOpenFrom = null;
function openMenu(btn, items) {
  menuOpenFrom = btn;
  btn.classList.add('open');
  popMenu(btn, items.filter(Boolean), { minWidth: 250 });
  // popMenu closes on any outside press, Esc, blur or resize; the row button follows it.
  const menu = document.querySelector('.menu:not(.leaving)');
  if (!menu) return void btn.classList.remove('open');
  new MutationObserver((_, mo) => {
    if (menu.isConnected && !menu.classList.contains('leaving')) return;
    mo.disconnect();
    btn.classList.remove('open');
    if (menuOpenFrom === btn) menuOpenFrom = null;
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

function menus() {
  const t = activeTab();
  const dark = document.documentElement.dataset.mode === 'dark';
  return [
    ['ORBIX', [
      { label: 'About ORBIX', run: () => H.settings('about') },
      { label: 'Check for updates', run: () => H.settings('about') },
      '-',
      { label: 'Settings', hint: 'Ctrl+,', run: () => H.settings() },
      { label: 'Providers and models', run: () => H.settings('engine') },
      '-',
      { label: 'How ORBIX works', run: H.help },
      { label: 'Keyboard shortcuts', run: H.shortcuts },
      { label: 'Check my setup', run: H.diagnostics },
    ]],
    ['Workspace', [
      { label: 'New conversation', hint: 'Ctrl+N', run: () => H.newSession() },
      { label: 'New conversation without saving it', run: () => H.newSession(undefined, { ephemeral: true }) },
      { label: 'Open project folder…', run: H.openFolder },
      '-',
      { label: 'Runs', hint: 'Ctrl+2', run: () => H.goHub('runs') },
      { label: 'Review', hint: 'Ctrl+3', run: () => H.goHub('review') },
      { label: 'Search everything', hint: 'Ctrl+K', run: () => H.search() },
      '-',
      { label: 'Manage conversations…', run: H.manage },
    ]],
    ['View', [
      { label: 'Sidebar', hint: 'Ctrl+B', on: H.sideShown(), run: H.toggleSidebar },
      t ? { label: 'Overview', on: overviewWanted(), run: toggleOverview } : null,
      t ? { label: 'Side panel', hint: 'Ctrl+J', on: H.panelShown(), run: H.togglePanel } : null,
      t ? { label: 'Focus mode', hint: 'Ctrl+Shift+F', on: document.documentElement.classList.contains('zen'), run: () => H.zen() } : null,
      t ? { label: 'Wide reading column', on: document.documentElement.classList.contains('wide'), run: H.wide } : null,
      '-',
      { label: dark ? 'Light theme' : 'Dark theme', run: H.toggleTheme },
      { label: 'Bigger text', hint: 'Ctrl+=', run: () => H.textSize(1) },
      { label: 'Smaller text', hint: 'Ctrl+-', run: () => H.textSize(-1) },
      { label: 'Reset text size', hint: 'Ctrl+0', run: () => H.textSize(0) },
    ]],
    ['Window', [
      { label: 'Back', hint: 'Alt+←', run: () => navGo(-1) },
      { label: 'Forward', hint: 'Alt+→', run: () => navGo(1) },
      '-',
      { label: 'Next conversation', hint: 'Ctrl+Tab', run: () => H.cycle(1) },
      { label: 'Previous conversation', hint: 'Ctrl+Shift+Tab', run: () => H.cycle(-1) },
      t ? { label: 'Close conversation', run: () => H.close(t) } : null,
      ...(S.tabs.size ? ['-', { header: 'Open conversations' }] : []),
      ...[...S.tabs.values()].slice(0, 9).map((x, i) => ({ label: x.name, hint: `Alt+${i + 1}`, on: x.id === S.active, run: () => H.open(x.id) })),
    ]],
  ];
}

export function drawMenubar(el) {
  const row = menus().map(([name]) => {
    const b = h('button', { class: 'mb-it', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => {
      if (menuOpenFrom === b) return document.querySelector('.menu:not(.leaving)')?._close?.();
      openMenu(b, menus().find((m) => m[0] === name)[1]);
      e.stopPropagation();
    } }, name);
    // With one menu open, moving along the row opens the next, as in any desktop menu bar.
    b.addEventListener('pointerenter', () => menuOpenFrom && menuOpenFrom !== b && openMenu(b, menus().find((m) => m[0] === name)[1]));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = [...el.querySelectorAll('.mb-it')];
      all[(all.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus();
    });
    return b;
  });
  el.replaceChildren(h('nav', { class: 'mb-row', 'aria-label': 'Menu' }, row), h('span', { class: 'mb-drag grow' }));
}

// ================= toolbar =================

const stateOf = (t) => (t.dead ? 'dead' : t.dialogs.some(isApproval) ? 'wait' : t.streaming ? 'run' : 'ok');
const elapsed = (t) => fmtElapsed(Math.max(0, Math.floor((Date.now() - (t.turnStartedAt || Date.now())) / 1000)));

function crumbs(t, hub) {
  if (t) {
    const st = stateOf(t);
    const g = gitState(t.workspace);
    const branch = t.worktree?.branch || g?.branch;
    const n = g?.files?.length || 0;
    return [
      h('button', { class: 'crumb', type: 'button', title: t.workspace, 'aria-haspopup': 'menu', onclick: (e) => H.projectMenu(t, e.currentTarget) }, h('bdi', null, baseName(t.workspace) || 'No folder')),
      h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('button', { class: 'crumb cur', type: 'button', title: `${t.name}\nDouble-click to rename`, ondblclick: () => H.rename(t), onclick: (e) => H.sessionMenu(t, e.currentTarget) }, h('span', { class: 'ell' }, t.name)),
      st === 'ok' ? null : h('span', { class: `crumb-st ${st}` }, h('span', { class: `dot ${st === 'wait' ? 'warn' : st}` }), st === 'run' ? h('span', { class: 'num', dataset: { tick: t.id } }, `Working ${elapsed(t)}`) : st === 'wait' ? 'Needs your OK' : 'Ended'),
      branch ? h('button', { class: 'crumb-br', type: 'button', title: n ? `Branch ${branch} · ${n} changed file${n === 1 ? '' : 's'}` : `Branch ${branch}`, onclick: () => showTab(t.worktree ? 'review' : 'changes') }, icon('branch', 12), h('span', { class: 'ell' }, h('bdi', null, branch)), n ? h('b', { class: 'num' }, n) : null) : null,
    ];
  }
  if (hub) return [h('span', { class: 'crumb cur static' }, hub.view === 'review' ? 'Review' : 'Runs')];
  return [h('span', { class: 'crumb cur static' }, 'New conversation')];
}

let topSig = '';
export function drawToolbar(el, { force = false } = {}) {
  const t = activeTab();
  const hub = !t && H.hubView();
  const g = t && gitState(t.workspace);
  const sig = JSON.stringify([S.active, hub?.view, hub?.id, H.sideShown(), H.panelShown(), !!document.getElementById('app')?.classList.contains('overlay-panel'), overviewWanted(), canGo(-1), canGo(1), t && [t.name, t.workspace, stateOf(t), t.worktree?.branch, g?.branch, g?.files?.length]]);
  if (!force && sig === topSig && el.childElementCount) return;
  topSig = sig;
  el.classList.toggle('busy', !!t?.streaming && !t.dead);
  const docked = H.panelShown() && !document.getElementById('app')?.classList.contains('overlay-panel');
  const panelBtn = () => iconBtn('panel-right', 'Side panel (Ctrl+J)', H.togglePanel, 'tb-panel' + (H.panelShown() ? ' on' : ''));
  const back = iconBtn('arrow-left', 'Back (Alt+←)', () => navGo(-1), 'tb-nav');
  const fwd = iconBtn('arrow-right', 'Forward (Alt+→)', () => navGo(1), 'tb-nav');
  back.disabled = !canGo(-1);
  fwd.disabled = !canGo(1);
  el.replaceChildren(...[
    h('div', { class: 'tb-lead' },
      h('button', { class: 'tb-mark', type: 'button', title: 'New conversation (Ctrl+N)', 'aria-label': 'New conversation', onclick: () => H.newSession() }, logo(20, { alive: true })),
      iconBtn('panel-left', 'Sidebar (Ctrl+B)', H.toggleSidebar, 'tb-side' + (H.sideShown() ? ' on' : '')),
      back, fwd,
      iconBtn('search', 'Search everything (Ctrl+K)', () => H.search(), 'tb-search')),
    h('div', { class: 'crumbs' }, crumbs(t, hub)),
    h('span', { class: 'grow tb-drag' }),
    t ? h('div', { class: 'tb-end' },
      iconBtn('more-v', 'Conversation actions', (e) => H.sessionMenu(t, e.currentTarget), 'tb-more'),
      iconBtn('overview', 'Overview (Ctrl+Alt+O)', toggleOverview, 'tb-ov' + (overviewShown() ? ' on' : '')),
      docked ? null : panelBtn()) : null,
    // With the side panel docked, its switch sits above it, and the conversation's own buttons end where the conversation does.
    t && docked ? h('div', { class: 'tb-pz' }, panelBtn()) : null,
  ].filter(Boolean));
}

/** Once a second while an agent works: its running time in the toolbar. */
export function tickToolbar(el) {
  for (const s of el.querySelectorAll('[data-tick]')) {
    const t = S.tabs.get(s.dataset.tick);
    if (t?.streaming) s.textContent = `Working ${elapsed(t)}`;
  }
}

// ================= Overview =================

const overviewWanted = () => S.ui.overview !== false;
const overviewShown = () => !!activeTab() && overviewWanted() && !H.panelShown();
/** The Overview button: with the side panel open it closes the panel and shows the card; otherwise it shows or hides the card. */
function toggleOverview() {
  // In a small window the card has no room: the button opens the side panel instead.
  if (!H.panelShown() && ovEl?.isConnected && !ovEl.getClientRects().length) return H.togglePanel();
  if (H.panelShown()) {
    if (!overviewWanted()) savePrefs({ overview: true });
    return H.togglePanel();
  }
  savePrefs({ overview: !overviewWanted() });
}

const ORDER = ['review', 'changes', 'files', 'console', 'todos', 'run'];
const LABEL = { run: ['Inspect', 'activity'], review: ['Review', 'check'], files: ['Files', 'file'], changes: ['Changes', 'branch'], todos: ['Plan', 'list'], console: ['Terminal', 'terminal'] };
let ovEl = null;
let ovSig = '';
export function syncOverview(host) {
  const t = activeTab();
  const show = overviewShown() && !document.documentElement.classList.contains('zen');
  if (!show) {
    ovEl?.remove();
    ovEl = null;
    ovSig = '';
    return;
  }
  const info = panelInfo(t);
  const working = H.workingCount();
  const sig = JSON.stringify([t.id, info.tabs.map((x) => x[0]), info.badge, working, t.subagents?.size || 0]);
  if (ovEl?.isConnected && sig === ovSig) return;
  ovSig = sig;
  const row = (k) => {
    const [label, ic] = LABEL[k];
    const n = info.badge[k];
    return h('button', { class: 'ov-it', type: 'button', onclick: () => showTab(k) }, icon(ic, 14), h('span', { class: 'grow' }, label), n ? h('span', { class: 'ov-n num' }, n) : null);
  };
  const fresh = !ovEl?.isConnected;
  const helpers = [...(t.subagents?.values() || [])].length;
  const have = new Set(info.tabs.map(([k]) => k));
  // Sections with nothing in them are left out, as in the side panel's own empty states.
  const el = h('aside', { class: 'overview' + (fresh ? ' in' : ''), 'aria-label': 'Overview' },
    h('div', { class: 'ov-h' }, h('span', null, 'Overview')),
    ORDER.filter((k) => have.has(k)).map(row),
    helpers || working ? h('div', { class: 'ov-sep' }) : null,
    helpers ? h('button', { class: 'ov-it ov-sub', type: 'button', onclick: () => showTab('agents') }, h('span', null, 'Subagents'), h('span', { class: 'ov-n num' }, String(helpers))) : null,
    working ? h('button', { class: 'ov-it ov-sub', type: 'button', onclick: () => H.goHub('runs') }, h('span', null, 'Background runs'), h('span', { class: 'ov-n num' }, String(working))) : null);
  if (ovEl?.isConnected) ovEl.replaceWith(el);
  else host.append(el);
  ovEl = el;
}

// ================= conversation preview card =================

let card = null;
let timer = 0;
function hideCard() {
  clearTimeout(timer);
  card?.remove();
  card = null;
}
/** Rest the pointer on a conversation row in `root` for a moment: a card shows its title, project, last update and state. */
export function bindHoverCards(root, resolve) {
  root.addEventListener('pointerover', (e) => {
    const row = e.target.closest?.('.s-btn[data-path]');
    if (!row || row.contains(e.relatedTarget)) return;
    hideCard();
    timer = setTimeout(() => {
      const d = row.isConnected && resolve(row.dataset.path);
      if (!d) return;
      const r = row.getBoundingClientRect();
      card = h('div', { class: 'hcard', role: 'tooltip' },
        h('div', { class: 'hc-t' }, d.title),
        h('div', { class: 'hc-l' }, icon('folder', 12), h('span', { class: 'ell' }, h('bdi', null, d.project))),
        d.branch ? h('div', { class: 'hc-l' }, icon('branch', 12), h('span', { class: 'ell' }, h('bdi', null, d.branch))) : null,
        h('div', { class: 'hc-l' }, icon('clock', 12), h('span', null, d.updated)),
        d.state ? h('div', { class: `hc-l hc-st ${d.state[0]}` }, h('span', { class: `dot ${d.state[0]}` }), h('span', null, d.state[1])) : null,
        d.preview ? h('div', { class: 'hc-p' }, d.preview) : null);
      document.body.append(card);
      const top = Math.max(8, Math.min(r.top - 6, innerHeight - card.offsetHeight - 8));
      card.style.left = `${Math.round(r.right + 10)}px`;
      card.style.top = `${Math.round(top)}px`;
    }, 450);
  });
  root.addEventListener('pointerout', (e) => {
    const row = e.target.closest?.('.s-btn[data-path]');
    if (row && !row.contains(e.relatedTarget)) hideCard();
  });
  for (const ev of ['pointerdown', 'scroll', 'keydown']) root.addEventListener(ev, hideCard, { passive: true, capture: ev === 'scroll' });
}
/** "Updated 2:15 PM" today, "Updated Tue 2:15 PM" this week, a date before that. */
export function updatedLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Updated ${time}`;
  if (now - d < 6 * 86400e3) return `Updated ${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `Updated ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })} · ${timeAgo(ts)} ago`;
}

on('prefs', () => emit('chrome'));
