// Home extras: a card to resume the last conversation, a 26-week activity map and ready-made tasks.
// Everything is read from real state (S.sessions, S.tabs); nothing is invented.
import { h, icon, baseName, timeAgo } from './dom.js';
import { S, tabForSession } from './store.js';
import { isApproval } from './dialogs.js';

const DAY = 864e5;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

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
    h('span', { class: 'ws-resume-k' }, 'Last conversation'),
    h('span', { class: 'ws-resume-t' }, s.title),
    s.preview && s.preview !== s.title ? h('span', { class: 'ws-resume-p' }, s.preview) : null,
    h('span', { class: 'ws-resume-m' },
      h('span', { class: 'ws-resume-proj' }, icon('folder', 12), baseName(s.cwdDisplay || s.cwd)),
      h('span', { class: `ws-resume-st ${state}` }, state === 'run' || state === 'wait' ? h('span', { class: 'dot ' + (state === 'wait' ? 'warn' : 'run') }) : null, label)),
    h('span', { class: 'ws-resume-go' }, 'Resume'));
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
  recipesEl = (h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Task recipes' }, ...RECIPES.map(([ic, t, text]) => h('button', { class: 'ws-recipe', type: 'button', title: text, onclick: () => {
    comp.value = text;
    comp.focus();
    comp.el.classList.remove('ws-fill');
    void comp.el.offsetWidth;
    comp.el.classList.add('ws-fill');
  } }, h('span', { class: 'ws-recipe-ic' }, icon(ic, 14)), h('span', { class: 'ws-recipe-t' }, t)))));
  recipesEl._comp = comp;
  return recipesEl;
}
