// The window chrome, laid out like a desktop app: a menu row (ORBIX, Workspace, View, Window; in the Windows app the
// window buttons sit at its right end), then the toolbar: the sidebar switch, back and forward, search, and where you
// are (the project's tile and name / the conversation, its ··· menu, state and branch); on the right how full the
// context is, the Context menu (MCP, skills, rules) and the side panel. Also here: back/forward history across
// conversations and views, and the card that previews a conversation when you rest the pointer on it in the sidebar.
// main.js owns the actions and passes them in through `H`.
import { h, icon, iconBtn, logo, baseName, fmtElapsed, timeAgo, projTile, fmtTokens } from './dom.js';
import { S, on, emit, activeTab, savePrefs } from './store.js';
import { popMenu, isApproval } from './dialogs.js';
import { contextMenu } from './context.js';
import { contextLevel, openContextBudget } from './context-popover.js';
import { gitState, showTab } from './panels.js';
import { firstKey } from './keys.mjs';
import { onMachine, backToThisPc } from './machines.js';
import { homeProject } from './home.js';
import { HUB_LINKS } from './hub-nav.js';
import { updatesSupported, checkForUpdates, updatePill } from './updates.js';

/** The key of a shortcut as you set it (Settings → Shortcuts), for menus and hints. */
const K = (id) => firstKey(S.ui.keys, id);
const tip = (text, id) => (K(id) ? `${text} (${K(id)})` : text);

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
const canGo = (dir) => step(dir) >= 0;
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
  // Over the full-window Settings, an action closes Settings first (opening Settings again just changes its page).
  const closingSettings = (it) => (it && typeof it === 'object' && it.run ? { ...it, run: (...a) => (emit('settings:close'), it.run(...a)) } : it);
  popMenu(btn, items.filter(Boolean).map(closingSettings), { minWidth: 250 });
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
      updatesSupported() ? { label: 'Check for updates', run: () => (checkForUpdates(), H.settings('application')) } : null,
      '-',
      { label: 'Settings', hint: K('settings'), run: () => H.settings() },
      { label: 'Providers and models', run: () => H.settings('engine') },
      '-',
      { label: 'How ORBIX works', run: H.help },
      { label: 'Keyboard shortcuts', run: H.shortcuts },
      { label: 'Check my setup', run: H.diagnostics },
    ]],
    ['Workspace', [
      { label: 'New conversation', hint: K('new'), run: () => H.newSession() },
      { label: 'New conversation without saving it', run: () => H.newSession(undefined, { ephemeral: true }) },
      { label: 'Open project folder…', run: H.openFolder },
      { label: 'Connect a provider or agent…', hint: K('connect'), run: () => H.connect() },
      '-',
      ...HUB_LINKS.map(({ label, view, key }) => ({ label, hint: key ? K(key) : undefined, run: () => H.goHub(view) })),
      { label: 'Search everything', hint: K('search'), run: () => H.search() },
      '-',
      { label: 'Manage conversations…', run: H.manage },
    ]],
    ['View', [
      { label: 'Sidebar', hint: K('sidebar'), on: H.sideShown(), run: H.toggleSidebar },
      t ? { label: 'Side panel', hint: K('panel'), on: H.panelShown(), run: H.togglePanel } : null,
      t || homeProject() ? { label: 'Terminal', hint: K('terminal'), on: H.terminalShown(), run: () => H.toggleTerminal() } : null,
      t ? { label: 'Focus mode', hint: K('zen'), on: document.documentElement.classList.contains('zen'), run: () => H.zen() } : null,
      t ? { label: 'Wide reading column', on: document.documentElement.classList.contains('wide'), run: H.wide } : null,
      '-',
      { label: dark ? 'Light theme' : 'Dark theme', run: H.toggleTheme },
      { label: 'Bigger text', hint: K('textBigger'), run: () => H.textSize(1) },
      { label: 'Smaller text', hint: K('textSmaller'), run: () => H.textSize(-1) },
      { label: 'Reset text size', hint: K('textReset'), run: () => H.textSize(0) },
    ]],
    ['Window', [
      { label: 'Back', hint: K('back'), run: () => navGo(-1) },
      { label: 'Forward', hint: K('forward'), run: () => navGo(1) },
      '-',
      { label: 'Next conversation', hint: K('nextConv'), run: () => H.cycle(1) },
      { label: 'Previous conversation', hint: K('prevConv'), run: () => H.cycle(-1) },
      t ? { label: 'Close conversation', run: () => H.close(t) } : null,
      ...(S.tabs.size ? ['-', { header: 'Open conversations' }] : []),
      ...[...S.tabs.values()].slice(0, 9).map((x, i) => ({ label: x.name, hint: `Alt+${i + 1}`, on: x.id === S.active, run: () => H.open(x.id) })),
    ]],
  ];
}

// The brand at the top left of the menu row is the mark alone (it swaps O and X while an agent works).
export function drawMenubar(el) {
  const row = menus().map(([name]) => {
    const b = h('button', { class: 'mb-it', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => {
      if (menuOpenFrom === b) return document.querySelector('.menu:not(.leaving)')?._close?.();
      openMenu(b, menus().find((m) => m[0] === name)[1]);
      e.stopPropagation();
    } }, ...(name === 'ORBIX' ? [logo(18, { alive: true })] : [name]));
    if (name === 'ORBIX') (b.classList.add('mb-brand'), b.setAttribute('aria-label', 'ORBIX'));
    // With one menu open, moving along the row opens the next, as in any desktop menu bar.
    b.addEventListener('pointerenter', () => menuOpenFrom && menuOpenFrom !== b && openMenu(b, menus().find((m) => m[0] === name)[1]));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const all = [...el.querySelectorAll('.mb-it')];
      all[(all.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus();
    });
    return b;
  });
  el.replaceChildren(h('nav', { class: 'mb-row', 'aria-label': 'Menu' }, row), h('span', { class: 'mb-drag grow' }), updatePill);
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
      h('button', { class: 'crumb crumb-proj', type: 'button', title: t.workspace, 'aria-haspopup': 'menu', onclick: (e) => H.projectMenu(t, e.currentTarget) }, projTile(baseName(t.workspace), 18), h('bdi', null, baseName(t.workspace) || 'No folder')),
      h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('span', { class: 'crumb cur', title: `${t.name}\nDouble-click to rename`, ondblclick: () => H.rename(t) }, h('span', { class: 'ell' }, t.name)),
      iconBtn('more', 'Conversation actions', (e) => H.sessionMenu(t, e.currentTarget), 'sm tb-more'),
      st === 'ok' ? null : h('span', { class: `crumb-st ${st}` }, h('span', { class: `dot ${st === 'wait' ? 'warn' : st}` }), st === 'run' ? h('span', { class: 'num', dataset: { tick: t.id } }, `Working ${elapsed(t)}`) : st === 'wait' ? 'Needs your OK' : 'Ended'),
      branch ? h('button', { class: 'crumb-br', type: 'button', title: n ? `Branch ${branch} · ${n} changed file${n === 1 ? '' : 's'}` : `Branch ${branch}`, onclick: () => showTab(t.worktree ? 'review' : 'changes') }, icon('branch', 12), h('span', { class: 'ell' }, h('bdi', null, branch)), n ? h('b', { class: 'num' }, n) : null) : null,
    ];
  }
  if (hub) return [h('span', { class: 'crumb cur static' }, HUB_LINKS.find(({ view }) => view === hub.view)?.label || 'Runs')];
  const ws = homeProject();
  return [ws ? h('span', { class: 'crumb crumb-proj static', title: ws }, projTile(baseName(ws), 18), h('bdi', null, baseName(ws))) : null, ws ? h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/') : null, h('span', { class: 'crumb cur static' }, 'New conversation')].filter(Boolean);
}

// ================= context meter =================

/** How full the conversation's context is: open the breakdown, cost and compact action. */
const meter = h('button', { class: 'tb-ctx', type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
const RING = 2 * Math.PI * 6;
const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
{
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  for (const c of [track, arc]) (c.setAttribute('cx', '8'), c.setAttribute('cy', '8'), c.setAttribute('r', '6'), svg.append(c));
  track.setAttribute('class', 'ring-track');
  arc.setAttribute('class', 'ring-arc');
  arc.setAttribute('stroke-dasharray', `0 ${RING}`);
  meter.append(svg, h('span', { class: 'num' }));
}
function syncMeter(t) {
  meter.hidden = !t || t.dead;
  if (meter.hidden) return;
  const u = t.stats?.contextUsage;
  const pct = u?.percent;
  const level = contextLevel(pct);
  meter.classList.toggle('hot', level === 'hot');
  meter.classList.toggle('crit', level === 'crit');
  arc.setAttribute('stroke-dasharray', `${((RING * Math.min(100, pct || 0)) / 100).toFixed(2)} ${RING.toFixed(2)}`);
  const label = u?.tokens > 0 ? `${fmtTokens(u.tokens)}${Number.isFinite(pct) ? ` · ${Math.floor(pct)}%` : ''}` : 'Context';
  if (meter.lastChild.textContent !== label) meter.lastChild.textContent = label;
  meter.title = u?.contextWindow ? `Context and cost · ${fmtTokens(u.tokens)} of ${fmtTokens(u.contextWindow)} tokens (${pct.toFixed(1)}%)${u.estimated ? ', estimated' : ''}` : 'Context and cost';
  meter.setAttribute('aria-label', meter.title);
}
meter.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && !tab.dead) openContextBudget(meter, tab, () => showTab('context'));
});
on('tab:state', (tab) => { if (tab === activeTab()) syncMeter(tab); });

let topSig = '';
export function drawToolbar(el, { force = false } = {}) {
  const t = activeTab();
  const hub = !t && H.hubView();
  const g = t && gitState(t.workspace);
  syncMeter(t);
  const sig = JSON.stringify([S.active, hub?.view, hub?.id, homeProject(), H.sideShown(), H.panelShown(), H.panelMax(), !!document.getElementById('app')?.classList.contains('overlay-panel'), canGo(-1), canGo(1), t && [t.name, t.workspace, stateOf(t), t.worktree?.branch, g?.branch, g?.files?.length]]);
  if (!force && sig === topSig && el.childElementCount) return;
  topSig = sig;
  el.classList.toggle('busy', !!t?.streaming && !t.dead);
  // Across the window, the panel takes the conversation's place: its switches end the toolbar like any other button.
  const wide = H.panelMax();
  const docked = H.panelShown() && !wide && !document.getElementById('app')?.classList.contains('overlay-panel');
  const panelBtn = () => iconBtn('panel-right', tip('Side panel', 'panel'), H.togglePanel, 'tb-panel' + (H.panelShown() ? ' on' : ''));
  const maxBtn = () => (H.panelShown() ? iconBtn(H.panelMax() ? 'minimize' : 'maximize', H.panelMax() ? 'Restore the side panel' : 'Side panel across the window', H.togglePanelMax, 'tb-max' + (H.panelMax() ? ' on' : '')) : null);
  // The project's MCP servers, skills and rules: always in the right-hand group, never alone at the panel's edge.
  const cxBtn = () => iconBtn('layers', tip('MCP servers, skills and rules', 'mcpMenu'), (e) => contextMenu(e.currentTarget, { ws: t?.workspace || homeProject(), tab: t, go: H.goHub, settings: H.settings }), 'tb-cx');
  const back = iconBtn('arrow-left', tip('Back', 'back'), () => navGo(-1), 'tb-nav');
  const fwd = iconBtn('arrow-right', tip('Forward', 'forward'), () => navGo(1), 'tb-nav');
  back.disabled = !canGo(-1);
  fwd.disabled = !canGo(1);
  el.replaceChildren(...[
    h('div', { class: 'tb-lead' },
      iconBtn('panel-left', tip('Sidebar', 'sidebar'), H.toggleSidebar, 'tb-side' + (H.sideShown() ? ' on' : '')),
      back, fwd,
      iconBtn('search', tip('Search everything', 'search'), () => H.search(), 'tb-search')),
    h('div', { class: 'crumbs' }, crumbs(t, hub)),
    // This window shows a machine (ORBIX Cloud): say which, and lead back to this PC.
    onMachine() ? h('button', { class: 'tb-machine', type: 'button', title: window.orbixDesktop?.machines ? 'Back to the ORBIX on this PC' : 'ORBIX on a machine', onclick: () => (window.orbixDesktop?.machines ? backToThisPc() : H.settings('machines')) }, icon('cloud', 13), location.hostname, window.orbixDesktop?.machines ? h('span', { class: 'muted' }, '· Back to this PC') : null) : null,
    h('span', { class: 'grow tb-drag' }),
    // The side panel works for a conversation, and on Home for the project chosen there.
    t || (!hub && homeProject()) ? h('div', { class: 'tb-end' },
      t ? meter : null,
      docked ? null : cxBtn(),
      wide ? maxBtn() : null,
      docked ? null : panelBtn()) : null,
    // With the side panel docked, the right-hand group sits above it: MCP, skills and rules, then the panel's switches.
    (t || (!hub && homeProject())) && docked ? h('div', { class: 'tb-pz' }, cxBtn(), maxBtn(), panelBtn()) : null,
  ].filter(Boolean));
}

/** Once a second while an agent works: its running time in the toolbar. */
export function tickToolbar(el) {
  for (const s of el.querySelectorAll('[data-tick]')) {
    const t = S.tabs.get(s.dataset.tick);
    if (t?.streaming) s.textContent = `Working ${elapsed(t)}`;
  }
  syncMeter(activeTab());
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
