// Workspace extras for Home: an ambient stage behind the hero, a live "Now" strip, a resume card for the last
// conversation, a 12-week activity map and task recipes. Everything here is read from real state (S.sessions, S.tabs,
// S.workspaces); nothing is invented. Motion is transform/opacity only and stops under prefers-reduced-motion.
import { h, icon, baseName, timeAgo, logo } from './dom.js';
import { S, tabForSession, setActive } from './store.js';
import { isApproval } from './dialogs.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const DAY = 864e5;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ================= ambient stage =================

/** Two soft orbs and a dot grid behind the hero. The orbs drift on their own and lean toward the pointer. */
export function heroFx(hero) {
  if (hero.querySelector('.ws-stage')) return;
  const stage = h('div', { class: 'ws-stage', 'aria-hidden': 'true' }, h('i', { class: 'ws-orb a' }), h('i', { class: 'ws-orb b' }), h('i', { class: 'ws-orb c' }), h('i', { class: 'ws-grid' }));
  hero.prepend(stage);
  if (reduced.matches) return;
  let raf = 0;
  let tx = 0, ty = 0, cx = 0, cy = 0;
  const tick = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    stage.style.setProperty('--px', cx.toFixed(3));
    stage.style.setProperty('--py', cy.toFixed(3));
    raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.002 ? requestAnimationFrame(tick) : 0;
  };
  const root = hero.closest('.welcome') || hero.parentElement;
  root.addEventListener('pointermove', (e) => {
    const r = hero.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
    ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1));
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
  root.addEventListener('pointerleave', () => {
    tx = ty = 0;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

/** A light that follows the pointer across every card on the page (one listener, CSS does the rest). */
export function spotlight(root) {
  if (root._spot || reduced.matches) return;
  root._spot = true;
  const SPOT = '.home-card, .ws-kpi, .ws-resume, .ws-recipe, .home-step, .pv-q';
  let raf = 0;
  let ev = null;
  const paint = () => {
    raf = 0;
    const card = ev.target.closest?.(SPOT);
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${Math.round(ev.clientX - r.left)}px`);
    card.style.setProperty('--my', `${Math.round(ev.clientY - r.top)}px`);
  };
  root.addEventListener('pointermove', (e) => {
    ev = e;
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });
}

/** The entrance plays once per mount of the page; later redraws (a tab's status changed) replace blocks in place. */
let entranceUntil = 0;
export const armEntrance = () => (entranceUntil = performance.now() + 700);

/** Marks the children of a container so they enter one after another. */
export function stagger(container) {
  if (!container || performance.now() > entranceUntil) return container;
  let i = 0;
  for (const el of container.children) {
    if (!(el instanceof HTMLElement) || el.hidden) continue;
    el.classList.add('ws-in');
    el.style.setProperty('--i', String(i++));
  }
  return container;
}

// ================= live strip =================

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}

/** Consecutive days (ending today or yesterday) with at least one conversation. */
function streak() {
  const days = new Set(S.sessions.map((s) => startOfDay(s.mtime)));
  let d = startOfDay(Date.now());
  if (!days.has(d)) d -= DAY;
  let n = 0;
  while (days.has(d)) {
    n++;
    d -= DAY;
  }
  return n;
}

/** Counts a number up into an element the first time it is shown; later redraws set it at once. */
const shown = new Map();
function countUp(el, to, key) {
  const from = shown.get(key);
  shown.set(key, to);
  if (reduced.matches || from === to || to === 0) {
    el.textContent = String(to);
    return;
  }
  const start = from ?? 0;
  const t0 = performance.now();
  const dur = 650;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(start + (to - start) * e));
    if (p < 1 && el.isConnected) requestAnimationFrame(step);
    else el.textContent = String(to);
  };
  requestAnimationFrame(step);
}

/**
 * What is happening right now, in six tiles: agents working, sessions waiting on you, conversations today, the day
 * streak, every conversation and every project. A tile with a target opens it.
 */
export function pulseStrip(H, projects) {
  const { working, waiting } = liveTabs();
  const today = startOfDay(Date.now());
  const todayN = S.sessions.filter((s) => startOfDay(s.mtime) === today).length;
  const openFirst = (list) => {
    const t = list[0];
    if (!t) return;
    const s = S.sessions.find((x) => tabForSession(x) === t);
    s ? H.openSession(s) : setActive(t.id);
  };
  const tiles = [
    { k: 'working', ic: 'activity', n: working.length, l: working.length === 1 ? 'agent working' : 'agents working', tone: working.length ? 'live' : '', run: working.length ? () => openFirst(working) : null },
    { k: 'waiting', ic: 'shield', n: waiting.length, l: waiting.length === 1 ? 'needs your OK' : 'need your OK', tone: waiting.length ? 'warn' : '', run: waiting.length ? () => openFirst(waiting) : null },
    { k: 'today', ic: 'bolt', n: todayN, l: todayN === 1 ? 'conversation today' : 'conversations today', tone: '' },
    { k: 'streak', ic: 'compass', n: streak(), l: 'day streak', tone: streak() >= 3 ? 'accent' : '' },
    { k: 'all', ic: 'message', n: S.sessions.length, l: S.sessions.length === 1 ? 'conversation' : 'conversations', tone: '', run: S.sessions.length ? H.manage : null },
    { k: 'proj', ic: 'folder', n: projects.length, l: projects.length === 1 ? 'project' : 'projects', tone: '', run: H.openFolder },
  ];
  const strip = h('section', { class: 'ws-pulse', 'aria-label': 'Right now' }, ...tiles.map((t) => {
    const num = h('b', { class: 'ws-kpi-n num' }, '0');
    countUp(num, t.n, t.k);
    const el = h(t.run ? 'button' : 'div', { class: `ws-kpi ${t.tone}${t.n ? '' : ' zero'}`, ...(t.run ? { type: 'button', onclick: t.run } : {}) },
      h('span', { class: 'ws-kpi-ic' }, icon(t.ic, 15)),
      num,
      h('span', { class: 'ws-kpi-l' }, t.l),
      t.tone === 'live' ? h('i', { class: 'ws-kpi-ping' }) : null);
    return el;
  }));
  return stagger(strip);
}

// ================= resume =================

/** The last conversation, big enough to read: where it was, what it was about, one click to continue. */
export function resumeCard(H) {
  const s = S.sessions[0];
  if (!s) return null;
  const tab = tabForSession(s);
  const waiting = tab && tab.dialogs.some(isApproval);
  const state = waiting ? 'wait' : tab?.streaming ? 'run' : tab ? 'open' : '';
  const label = waiting ? 'Needs your OK' : tab?.streaming ? 'Working now' : tab ? 'Open in a tab' : `Last active ${timeAgo(s.mtime)}`;
  return h('button', { class: `ws-resume ${state}`, type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
    h('span', { class: 'ws-resume-k' }, icon('undo', 13), 'Pick up where you left off'),
    h('span', { class: 'ws-resume-t' }, s.title),
    s.preview && s.preview !== s.title ? h('span', { class: 'ws-resume-p' }, s.preview) : null,
    h('span', { class: 'ws-resume-m' },
      h('span', { class: 'ws-resume-proj' }, icon('folder', 12), baseName(s.cwdDisplay || s.cwd)),
      h('span', { class: `ws-resume-st ${state}` }, state === 'run' || state === 'wait' ? h('span', { class: 'dot ' + (state === 'wait' ? 'warn' : 'run') }) : null, label)),
    h('span', { class: 'ws-resume-go' }, 'Resume', icon('chevron-right', 14)));
}

// ================= activity map =================

/** Twelve weeks of conversations, one cell per day, the way a contribution graph reads. */
export function heatmapCard(projects) {
  const today = startOfDay(Date.now());
  const weeks = 26;
  let start = startOfDay(today - (weeks * 7 - 1) * DAY);
  start = startOfDay(start - new Date(start).getDay() * DAY); // back to that week's Sunday, so columns are whole weeks
  const counts = new Map();
  for (const s of S.sessions) {
    const d = startOfDay(s.mtime);
    if (d >= start && d <= today) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  const level = (n) => (!n ? 0 : n >= max ? 4 : Math.max(1, Math.ceil((n / max) * 4)));
  const cols = [];
  const months = [];
  let lastMonth = -1;
  for (let w = 0; d(w, 0) <= today; w++) {
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const day = d(w, i);
      if (day > today) break;
      const n = counts.get(day) || 0;
      const dt = new Date(day);
      cells.push(h('i', { class: `ws-hm-c l${level(n)}${day === today ? ' today' : ''}`, title: `${dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${n} conversation${n === 1 ? '' : 's'}` }));
    }
    const m = new Date(d(w, 0)).getMonth();
    months.push(h('span', { class: 'ws-hm-mo' }, m !== lastMonth ? new Date(d(w, 0)).toLocaleDateString(undefined, { month: 'short' }) : ''));
    lastMonth = m;
    cols.push(h('span', { class: 'ws-hm-w' }, ...cells));
  }
  function d(w, i) { return startOfDay(start + (w * 7 + i) * DAY + DAY / 2); } // noon-anchored so DST never skips a day
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const active = counts.size;
  const best = Math.max(0, ...counts.values());
  const stat = (n, l) => h('div', { class: 'ws-hm-stat' }, h('b', { class: 'num' }, String(n)), h('span', null, l));
  return h('section', { class: 'home-card ws-hm', 'aria-label': `Activity, last ${weeks} weeks` },
    h('div', { class: 'home-card-h' }, h('h2', null, 'Activity'), h('span', { class: 'ws-hm-sum' }, `Last ${weeks} weeks`)),
    h('div', { class: 'ws-hm-b' },
      h('div', { class: 'ws-hm-stats' },
        stat(total, total === 1 ? 'conversation' : 'conversations'),
        stat(active, active === 1 ? 'active day' : 'active days'),
        stat(best, 'best day'),
        stat(projects.length, projects.length === 1 ? 'project' : 'projects')),
      h('div', { class: 'ws-hm-right' },
        h('div', { class: 'ws-hm-mos' }, ...months),
        h('div', { class: 'ws-hm-g', role: 'img', 'aria-label': `Conversations per day over the last ${weeks} weeks` }, ...cols),
        h('div', { class: 'ws-hm-foot' },
          h('span', { class: 'ws-hm-leg' }, 'Less', ...[0, 1, 2, 3, 4].map((l) => h('i', { class: `ws-hm-c l${l}` })), 'More')))));
}

// ================= recipes =================

/** Ready-made tasks. A click puts the text in the box, ready to edit and send. */
const RECIPES = [
  ['eye', 'Explain this project', 'Explain how this project is put together: entry points, main modules, how data flows, and where to start reading.'],
  ['alert', 'Fix the failing test', 'Run the test suite, find the failing test, explain the root cause and fix it with the smallest safe change.'],
  ['search', 'Review my changes', 'Review my uncommitted changes for bugs, edge cases and anything that would surprise a reviewer. Do not change files; list findings by severity.'],
  ['check', 'Write tests', 'Find the most important code paths that have no tests and write focused tests for them, matching the existing test style.'],
  ['shield', 'Security check', 'Audit this project for security issues: injection, secrets in code, unsafe shell or file access, missing input validation. Report findings with file and line.'],
  ['bolt', 'Find slow spots', 'Profile or reason about the hot paths in this project and point out the three biggest performance problems, with concrete fixes.'],
  ['wrench', 'Refactor safely', 'Find the most tangled module and refactor it for clarity without changing behaviour. Keep the tests green and explain each step.'],
  ['file', 'Write the docs', 'Write or update the README so a new developer can install, run and test this project in five minutes.'],
];
let recipesEl = null;
export function recipes(comp) {
  if (recipesEl?._comp === comp) return recipesEl;
  recipesEl = stagger(h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Task recipes' }, ...RECIPES.map(([ic, t, text]) => h('button', { class: 'ws-recipe', type: 'button', title: text, onclick: () => {
    comp.value = text;
    comp.focus();
    comp.el.classList.remove('ws-fill');
    void comp.el.offsetWidth;
    comp.el.classList.add('ws-fill');
  } }, h('span', { class: 'ws-recipe-ic' }, icon(ic, 14)), h('span', { class: 'ws-recipe-t' }, t)))));
  recipesEl._comp = comp;
  return recipesEl;
}

/** The brand line under the hero on a fresh install: three short promises with the mark. */
export function promise() {
  return h('div', { class: 'ws-promise', 'aria-hidden': 'true' }, logo(14), h('span', null, 'Reads first'), h('i'), h('span', null, 'Asks before changes'), h('i'), h('span', null, 'Everything undoable'));
}
