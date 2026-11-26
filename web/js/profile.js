// Settings → Profile: who you are in ORBIX and what you and your agents have done on this PC, since the first
// conversation. Your name and handle (yours to set, kept in ORBIX's settings), lifetime tokens and messages, the busiest
// day, streaks, a year of activity by day, and what you use most. The 7/30/90-day charts (analytics.js) follow below.
// Every number comes from the conversations saved on this PC; nothing is sent anywhere.
import { h, icon, fmtTokens, errorState, skeleton, baseName, copyText } from './dom.js';
import { api } from './api.js';
import { S, savePrefs } from './store.js';
import { tabAnalytics } from './analytics.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
};
const hoursText = (ms) => (ms >= 3600000 ? `${(ms / 3600000).toFixed(ms >= 36000000 ? 0 : 1)} h` : ms >= 60000 ? `${Math.round(ms / 60000)} min` : ms ? '<1 min' : '—');
const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
const hourText = (hr) => `${String(hr).padStart(2, '0')}:00–${String((hr + 1) % 24).padStart(2, '0')}:00`;
const providerName = (id) => S.engine?.providers?.find((p) => p.id === id)?.name || S.engine?.agents?.find((a) => a.id === id)?.name || id;

/** The name shown on the profile (and in the sidebar's footer): yours if set, otherwise "You". */
export const me = () => ({ name: (S.ui.profileName || '').trim() || 'You', handle: (S.ui.profileHandle || '').trim().replace(/^@+/, '') });
/** Up to two letters for an avatar: "QUANTUM" → "Q", "Ada Lovelace" → "AL". */
export const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';

function header(onEdit, share) {
  const { name, handle } = me();
  return h('section', { class: 'pf-head' },
    h('div', { class: 'pf-acts' },
      h('button', { class: 'btn sm', type: 'button', onclick: share }, icon('copy', 14), 'Copy summary'),
      h('button', { class: 'btn sm', type: 'button', onclick: onEdit }, icon('pencil', 14), 'Edit')),
    h('span', { class: 'pf-avatar', 'aria-hidden': 'true' }, initials(name)),
    h('h3', { class: 'pf-name' }, name),
    h('p', { class: 'pf-handle' }, handle ? `@${handle}` : 'Set your name and handle with Edit', h('span', { class: 'pf-chip' }, 'ORBIX')));
}

function editor(done) {
  const { name, handle } = me();
  const nameIn = h('input', { type: 'text', value: name === 'You' ? '' : name, placeholder: 'Your name', maxlength: 40, 'aria-label': 'Name', spellcheck: 'false' });
  const handleIn = h('input', { type: 'text', value: handle, placeholder: 'handle', maxlength: 30, 'aria-label': 'Handle', spellcheck: 'false', autocomplete: 'off' });
  const save = () => {
    savePrefs({ profileName: nameIn.value.trim().slice(0, 40), profileHandle: handleIn.value.trim().replace(/^@+/, '').replace(/\s+/g, '').slice(0, 30) });
    done();
  };
  const form = h('form', { class: 'pf-edit', onsubmit: (e) => (e.preventDefault(), save()) },
    h('label', { class: 'field' }, h('span', null, 'Name'), nameIn),
    h('label', { class: 'field' }, h('span', null, 'Handle'), h('span', { class: 'pf-at' }, '@', handleIn)),
    h('div', { class: 'pf-edit-acts' }, h('button', { class: 'btn sm', type: 'button', onclick: done }, 'Cancel'), h('button', { class: 'btn sm primary', type: 'submit' }, 'Save')));
  queueMicrotask(() => nameIn.focus());
  return form;
}

function stats(p) {
  const cells = [
    ['Lifetime tokens', p.tokens ? fmtTokens(p.tokens) : '—', p.tokens ? `${p.tokens.toLocaleString()} tokens` : ''],
    ['Busiest day', p.peakDay ? fmtTokens(p.peakDay.tokens) : '—', p.peakDay ? `${dayLabel(p.peakDay.date)}: ${p.peakDay.tokens.toLocaleString()} tokens` : ''],
    ['Your messages', p.prompts.toLocaleString(), ''],
    ['Current streak', days(p.streak.current), 'Days in a row with a message of yours, up to today'],
    ['Longest streak', days(p.streak.longest), ''],
  ];
  return h('div', { class: 'pf-stats' }, cells.map(([k, v, t]) => h('div', { class: 'pf-stat', title: t || null }, h('b', { class: 'num' }, v), h('span', null, k))));
}

/** A year of days as weeks (columns) by weekday (rows), Sunday on top; month names over the first week of each month. */
function activity(p) {
  const max = Math.max(1, ...p.year.map((d) => d.prompts));
  const level = (n) => (!n ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const weeks = [];
  for (let i = 0; i < p.year.length; i += 7) weeks.push(p.year.slice(i, i + 7));
  let lastMonth = -1;
  const months = weeks.map((w) => {
    const m = Number(w[0].date.slice(5, 7)) - 1;
    if (m === lastMonth) return h('span', { class: 'pf-mo' });
    lastMonth = m;
    return h('span', { class: 'pf-mo' }, MONTHS[m]);
  });
  const grid = h('div', { class: 'pf-grid', role: 'img', 'aria-label': `Your messages per day over the last year: ${p.activeDays} active day${p.activeDays === 1 ? '' : 's'}` },
    p.year.map((d) => h('span', { class: `pf-day l${level(d.prompts)}`, title: `${dayLabel(d.date)}: ${d.prompts ? `${d.prompts} message${d.prompts === 1 ? '' : 's'}, ${fmtTokens(d.tokens)} tokens` : 'no messages'}` })));
  // Every week gets an equal share of the width, so the whole year (today included) always fits.
  const monthsRow = h('div', { class: 'pf-months', 'aria-hidden': 'true' }, months);
  for (const el of [monthsRow, grid]) el.style.gridTemplateColumns = `repeat(${weeks.length}, minmax(0, 1fr))`;
  return h('section', { class: 'pf-sec' },
    h('h4', { class: 'pf-h' }, 'Activity'),
    h('div', { class: 'pf-cal' }, monthsRow, grid),
    h('div', { class: 'pf-legend', 'aria-hidden': 'true' }, 'Less', [0, 1, 2, 3, 4].map((l) => h('span', { class: `pf-day l${l}` })), 'More'));
}

function insights(p) {
  const top = p.models[0];
  const rows = [
    ['Most used provider', p.topProvider ? providerName(p.topProvider) : '—'],
    ['Most used model', top ? top.model : '—'],
    ['Most active hour', p.topHour == null ? '—' : hourText(p.topHour)],
    ['Most worked project', p.topProject ? h('span', { title: p.topProject.path }, baseName(p.topProject.path)) : '—'],
    ['Active days', p.activeDays.toLocaleString()],
    ['Agent time', hoursText(p.workMs)],
    ['Conversations', p.conversations.toLocaleString()],
  ];
  const share = p.models.length ? h('div', { class: 'pf-models' }, p.models.map((m) => {
    const bar = h('i');
    bar.style.width = `${Math.max(2, Math.round(m.share * 100))}%`;
    return h('div', { class: 'pf-model', title: `${m.replies.toLocaleString()} repl${m.replies === 1 ? 'y' : 'ies'}${m.provider ? `, ${providerName(m.provider)}` : ''}` },
      h('span', { class: 'pf-mn ell' }, m.model), h('span', { class: 'pf-bar' }, bar), h('span', { class: 'pf-mv num' }, `${Math.round(m.share * 100)}%`));
  })) : h('p', { class: 'pf-empty' }, 'No replies yet.');
  return h('div', { class: 'pf-two' },
    h('section', { class: 'pf-sec' }, h('h4', { class: 'pf-h' }, 'Insights'), h('dl', { class: 'pf-list' }, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))))),
    h('section', { class: 'pf-sec' }, h('h4', { class: 'pf-h' }, 'Model usage'), h('p', { class: 'pf-sub' }, 'Share of replies, all time.'), share));
}

export function tabProfile(el) {
  const root = h('div', { class: 'pf' });
  const charts = h('div', { class: 'pf-charts' });
  el.append(root, h('h4', { class: 'pf-h pf-range-h' }, 'By range'), charts);
  let data = null;
  let editing = false;
  const summary = () => {
    const { name } = me();
    if (!data || data.error) return `${name} on ORBIX`;
    return [`${name} on ORBIX`, `${fmtTokens(data.tokens)} tokens, ${data.prompts.toLocaleString()} messages, ${data.conversations.toLocaleString()} conversations`, `Longest streak: ${days(data.streak.longest)}`, data.models[0] ? `Most used model: ${data.models[0].model}` : ''].filter(Boolean).join('\n');
  };
  const draw = () => {
    const head = editing ? h('section', { class: 'pf-head' }, editor(() => ((editing = false), draw()))) : header(() => ((editing = true), draw()), () => copyText(summary()));
    if (!data) return root.replaceChildren(head, skeleton(6, 'pad'));
    if (data.error) return root.replaceChildren(head, errorState(data.error, { title: 'Couldn’t read your conversations.', retry: load }));
    root.replaceChildren(head, stats(data), activity(data), insights(data));
  };
  const load = async () => {
    data = null;
    draw();
    try {
      data = await api.get('/api/profile');
    } catch (e) {
      data = { error: e.message };
    }
    if (root.isConnected) draw();
  };
  load();
  return tabAnalytics(charts);
}
