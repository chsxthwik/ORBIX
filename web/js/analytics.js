// Settings → Profile, by range: what your agents did over the last 7, 30 or 90 days, from the conversations saved on this PC.
// The total for the token kind you choose, tokens per day, your messages and agent time, the models used, and when in
// the week you prompt. One series per chart in one hue; every mark has a tooltip, and a table holds every number.
import { h, fmtTokens, errorState, skeleton } from './dom.js';
import { api } from './api.js';
import { S, savePrefs } from './store.js';

const KINDS = [['all', 'All tokens'], ['output', 'Written'], ['input', 'Read'], ['cache', 'From cache']];
const RANGES = [[7, '7d'], [30, '30d'], [90, '90d']];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // rows; data comes Sunday-first
const tokensOf = (d, kind) => (kind === 'output' ? d.output : kind === 'input' ? d.input : kind === 'cache' ? d.cacheRead + d.cacheWrite : d.input + d.output + d.cacheRead + d.cacheWrite);
const dateLabel = (k, opts = { month: 'short', day: 'numeric' }) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
};
const hoursText = (ms) => (ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

function segment(label, options, value, onPick) {
  const wrap = h('div', { class: 'seg an-seg', role: 'radiogroup', 'aria-label': label });
  for (const [v, l] of options) wrap.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: () => onPick(v) }, l));
  return wrap;
}

/** One floating tooltip for every mark on the page. */
function tooltip(root) {
  const tip = h('div', { class: 'an-tip', role: 'tooltip', hidden: true });
  root.append(tip);
  const show = (el, lines) => {
    tip.replaceChildren(...lines.map((l, i) => h(i ? 'span' : 'b', null, l)));
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const p = root.getBoundingClientRect();
    const x = Math.max(4, Math.min(r.left - p.left + r.width / 2 - tip.offsetWidth / 2, p.width - tip.offsetWidth - 4));
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top - p.top - tip.offsetHeight - 8}px`;
  };
  const hide = () => (tip.hidden = true);
  return (el, lines) => {
    el.addEventListener('pointerenter', () => show(el, lines));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', () => show(el, lines));
    el.addEventListener('blur', hide);
    return el;
  };
}

/** A column per day, one hue, baseline-anchored; the first, middle and last dates under it. */
function columns(days, value, describe, tip, cls = '') {
  const max = Math.max(1, ...days.map(value));
  const bars = days.map((d) => {
    const v = value(d);
    const bar = h('i', { class: v ? '' : 'zero' });
    bar.style.setProperty('--v', `${(v / max) * 100}%`);
    return tip(h('span', { class: 'an-col', tabindex: '0', role: 'img', 'aria-label': describe(d).join(', ') }, bar), describe(d));
  });
  const mid = days[Math.floor(days.length / 2)];
  return h('div', { class: `an-chart ${cls}`.trim() },
    h('div', { class: 'an-cols' }, bars),
    h('div', { class: 'an-axis' }, h('span', null, dateLabel(days[0].date)), h('span', null, dateLabel(mid.date)), h('span', null, 'Today')));
}

export function tabAnalytics(el) {
  let range = [7, 30, 90].includes(S.ui.analyticsRange) ? S.ui.analyticsRange : 30;
  let kind = KINDS.some(([k]) => k === S.ui.analyticsKind) ? S.ui.analyticsKind : 'all';
  let data = null;
  const root = h('div', { class: 'an' });
  el.append(root);
  const tip = tooltip(root);

  const draw = () => {
    root.querySelectorAll(':scope > :not(.an-tip)').forEach((x) => x.remove());
    const top = h('div', { class: 'an-top' }, segment('Range', RANGES, range, (v) => {
      range = v;
      savePrefs({ analyticsRange: v });
      load();
    }));
    if (!data) return root.prepend(top, skeleton(8, 'pad'));
    if (data.error) return root.prepend(top, errorState(data.error, { title: 'Couldn’t read your conversations.', retry: load }));
    const days = data.days;
    const total = days.reduce((n, d) => n + tokensOf(d, kind), 0);
    const prompts = days.reduce((n, d) => n + d.prompts, 0);
    const work = days.reduce((n, d) => n + d.workMs, 0);
    const kindName = KINDS.find(([k]) => k === kind)[1];

    const hero = h('section', { class: 'an-sec' },
      h('div', { class: 'an-head' },
        h('div', null, h('div', { class: 'an-eyebrow' }, `${kindName} · last ${range} days`), h('div', { class: 'an-hero num' }, total.toLocaleString())),
        segment('Token kind', KINDS, kind, (v) => {
          kind = v;
          savePrefs({ analyticsKind: v });
          draw();
        })),
      total ? columns(days, (d) => tokensOf(d, kind), (d) => [dateLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }), `${tokensOf(d, kind).toLocaleString()} ${kindName.toLowerCase()}`, `${d.prompts} message${d.prompts === 1 ? '' : 's'} from you`], tip) : h('p', { class: 'an-empty' }, 'No tokens counted in this range yet.'));

    const busiest = data.busiestDay ? dateLabel(data.busiestDay, { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
    const tiles = h('div', { class: 'an-tiles' },
      [['Your messages', prompts.toLocaleString()], ['Agent time', work ? hoursText(work) : '—'], ['Busiest day', busiest]]
        .map(([k, v]) => h('div', { class: 'an-tile' }, h('span', null, k), h('b', { class: 'num' }, v))));

    const work_ = work ? h('section', { class: 'an-sec' },
      h('h4', { class: 'an-h' }, 'Agent time per day'),
      h('p', { class: 'an-sub' }, 'From each message of yours to the end of the agent’s last reply to it.'),
      columns(days, (d) => d.workMs, (d) => [dateLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' }), d.workMs ? hoursText(d.workMs) : 'No agent time'], tip, 'short')) : null;

    const mt = data.models.reduce((n, m) => n + m.tokens, 0) || 1;
    const models = h('section', { class: 'an-sec' },
      h('h4', { class: 'an-h' }, 'Models'),
      h('p', { class: 'an-sub' }, 'Every model that replied in the range, most tokens first.'),
      data.models.length ? h('div', { class: 'an-models' }, data.models.map((m) => {
        const bar = h('i');
        bar.style.setProperty('--v', `${(m.tokens / data.models[0].tokens) * 100}%`);
        return tip(h('div', { class: 'an-model', tabindex: '0' },
          h('span', { class: 'an-mn ell', title: m.provider ? `${m.provider}/${m.model}` : m.model }, m.model),
          h('span', { class: 'an-bar' }, bar),
          h('span', { class: 'an-mv num' }, fmtTokens(m.tokens))), [m.model, `${m.tokens.toLocaleString()} tokens (${Math.round((m.tokens / mt) * 100)}%)`, `${m.replies} repl${m.replies === 1 ? 'y' : 'ies'}${m.provider ? ` · ${m.provider}` : ''}`]);
      })) : h('p', { class: 'an-empty' }, 'No replies in this range yet.'));

    const heatMax = Math.max(1, ...data.heat.flat());
    const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
    const heat = h('section', { class: 'an-sec' },
      h('h4', { class: 'an-h' }, 'When you prompt'),
      h('p', { class: 'an-sub' }, 'Your messages by weekday and hour, in your time zone.'),
      h('div', { class: 'an-heat', role: 'grid', 'aria-label': 'Your messages by weekday and hour' },
        order.map((wd, r) => h('div', { class: 'an-hrow', role: 'row' },
          h('span', { class: 'an-dow' }, DOW[r]),
          data.heat[wd].map((v, hr) => {
            const step = v ? Math.min(4, Math.ceil((v / heatMax) * 4)) : 0;
            const label = [`${DOW[r]} ${String(hr).padStart(2, '0')}:00`, `${v} message${v === 1 ? '' : 's'}`];
            return tip(h('span', { class: `an-cell s${step}`, role: 'gridcell', tabindex: '-1', 'aria-label': label.join(', ') }), label);
          }))),
        h('div', { class: 'an-hrow an-hours', 'aria-hidden': 'true' }, h('span', { class: 'an-dow' }), Array.from({ length: 24 }, (_, i) => h('span', { class: 'an-hl' }, i % 6 === 0 ? String(i) : '')))),
      h('div', { class: 'an-legend', 'aria-hidden': 'true' }, 'Fewer', [0, 1, 2, 3, 4].map((s) => h('span', { class: `an-cell s${s}` })), 'More'));

    const table = h('details', { class: 'an-table' },
      h('summary', null, 'Every day as a table'),
      h('div', { class: 'an-tw' }, h('table', null,
        h('thead', null, h('tr', null, ['Day', 'Read', 'Written', 'Cache read', 'Cache write', 'Messages', 'Agent time'].map((x) => h('th', null, x)))),
        h('tbody', null, [...days].reverse().map((d) => h('tr', null, h('td', null, dateLabel(d.date, { weekday: 'short', month: 'short', day: 'numeric' })), [d.input, d.output, d.cacheRead, d.cacheWrite, d.prompts].map((v) => h('td', { class: 'num' }, v.toLocaleString())), h('td', { class: 'num' }, d.workMs ? hoursText(d.workMs) : '—')))))));

    root.prepend(top, hero, tiles, work_ || '', models, heat, table, h('p', { class: 'an-note' }, `From the ${data.conversations.toLocaleString()} conversation${data.conversations === 1 ? '' : 's'} saved on this PC. Agent CLIs that do not report their tokens count as 0.`));
  };

  const load = async () => {
    data = null;
    draw();
    try {
      data = await api.get(`/api/analytics?range=${range}`);
    } catch (e) {
      data = { error: e.message };
    }
    if (root.isConnected) draw();
  };
  load();
}
