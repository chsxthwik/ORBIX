import { rpc } from './api.js';
import { btn, popover } from './dialogs.js';
import { errorState, fmtTokens, h, replace, skeleton, toast } from './dom.js';
import { activeTab, on } from './store.js';

export const contextLevel = (percent) => percent >= 95 ? 'crit' : percent >= 80 ? 'hot' : '';
/** A share as text. Below 1% it keeps a decimal, and anything above zero never reads as 0%. */
export const percentText = (n) => !Number.isFinite(n) ? '' : n <= 0 ? '0%' : n < 0.1 ? '<0.1%' : n < 1 ? `${(Math.floor(n * 10) / 10).toFixed(1)}%` : `${Math.floor(n)}%`;
const number = (n) => n.toLocaleString();
const costText = (n) => n === 0 ? '$0.00' : n < 0.0001 ? '<$0.0001' : `$${n.toFixed(n < 1 ? 4 : 2)}`;
const labels = { system: 'System prompt', tools: 'Tool definitions', rules: 'Project rules', skills: 'Skills', mcp: 'MCP servers', files: 'Files attached', history: 'Conversation history', results: 'Tool results' };
const label = (key) => labels[key] || key;

export function contextBar(usage) {
  if (!Number.isFinite(usage?.percent)) return null;
  const bar = h('div', { class: `ctx-bar ${contextLevel(usage.percent)}`.trim(), role: 'meter', 'aria-label': 'Context window used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, usage.percent)), 'aria-valuetext': percentText(usage.percent) }, h('i'));
  bar.firstChild.style.setProperty('--p', `${Math.min(100, usage.percent)}%`);
  return bar;
}

export const compactBlock = (tab, stats) => tab.dialogs?.length ? 'Answer the pending approval or question first.'
  : tab.compacting ? 'Compacting context…' : tab.streaming ? 'Wait for the agent to finish first.' : stats?.compactBlock || '';

export async function requestCompaction(tab) {
  const blocked = compactBlock(tab);
  if (blocked) return toast(blocked, 'info');
  try {
    await rpc(tab.id, { type: 'compact' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Where the numbers come from, in a few words: the provider's own count, or ORBIX's estimate; and the limit. */
function sourceText(u) {
  const usage = u.reported ? 'Reported by the provider' : u.lastRequest ? 'Estimated since the last reply' : 'Estimated';
  const limit = !u.contextWindow ? 'limit unknown' : u.windowEstimated ? 'limit estimated' : '';
  return limit ? `${usage}, ${limit}` : usage;
}

/**
 * The context panel. The toolbar meter and the message box's ring both open it, and it reads one thing: the
 * conversation's `get_context_budget` reply, kept fresh by the conversation's own state events. Top to bottom:
 * usage and limit, the breakdown by part, cost, then Details and Compact. One panel at a time.
 */
let current;
let panels = 0;
export function openContextBudget(anchor, tab, openDetails) {
  if (current?.tab === tab && current.anchor === anchor) return current.close();
  current?.close(false);
  const id = `cx-${++panels}`;
  const title = h('h2', { class: 'cx-title', tabindex: '-1' }, 'Context');
  const badge = h('span', { class: 'cx-badge num' });
  const body = h('div', { class: 'cx-main' }, skeleton(3));
  const note = h('p', { class: 'cx-note', role: 'status', id: `${id}-note` });
  const compact = btn('Compact now', () => requestCompaction(tab), 'sm');
  compact.setAttribute('aria-describedby', note.id);
  const details = openDetails ? h('button', { class: 'cx-link', type: 'button', onclick: () => (pop.close(false), openDetails()) }, 'Details') : null;
  const foot = h('div', { class: 'cx-foot' }, details, h('span', { class: 'grow' }), compact);
  compact.disabled = true;
  let stats = tab.stats?.contextUsage ? { ...tab.stats } : null;
  let loading = true;
  let failed = '';
  let seq = 0;
  const pop = popover(anchor, h('div', { class: 'cx-body' }, h('header', { class: 'cx-head' }, title, badge), body, note, foot), {
    align: 'end', cls: 'cx-pop', label: 'Context',
    onClose: () => {
      anchor.setAttribute('aria-expanded', 'false');
      if (current === state) current = null;
    },
  });
  const state = { ...pop, tab, anchor, update: refresh };
  current = state;
  anchor.setAttribute('aria-expanded', 'true');
  title.focus({ preventScroll: true });
  // Tab stays inside the panel; Escape (dialogs.js) closes it and hands the focus back to the button that opened it.
  pop.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const stops = [...pop.el.querySelectorAll('button:not(:disabled), a[href]')];
    if (!stops.length) return e.preventDefault();
    const at = stops.indexOf(document.activeElement);
    const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
    e.preventDefault();
    stops[next].focus();
  });

  function updateActions() {
    const blocked = compactBlock(tab, stats);
    const busy = !!tab.compacting;
    compact.disabled = loading || !stats?.contextUsage || !!blocked;
    compact.textContent = busy ? 'Compacting…' : 'Compact now';
    compact.setAttribute('aria-busy', String(busy));
    compact.title = blocked ? '' : 'Summarize older turns. The latest six stay as they are.';
    const r = tab.compactionResult?.result;
    const err = tab.compactionResult?.error;
    // One line under the numbers: how the last compaction went, else why Compact is off right now.
    const outcome = err ? `Couldn’t compact: ${err}`
      : r ? (r.tokensSaved > 0 ? `${number(r.tokensSaved)} tokens saved (${number(r.tokensBefore)} → ${number(r.tokensAfter)})` : 'Compacted. The estimate did not decrease.') : '';
    const why = !outcome && blocked && !loading && !failed ? blocked : '';
    note.textContent = busy ? '' : outcome || why;
    note.className = `cx-note ${busy ? '' : err ? 'err' : r ? 'ok' : ''}`.trim();
  }

  function render() {
    const u = stats?.contextUsage;
    const cw = u?.contextWindow;
    const level = contextLevel(u?.percent);
    const approx = u && !u.reported ? '~' : '';
    badge.textContent = u && Number.isFinite(u.percent) ? `${percentText(u.percent)} used` : '';
    badge.className = `cx-badge num ${level}`.trim();
    if (!u) {
      replace(body, h('p', { class: 'cx-empty' }, `${stats?.contextOwner || 'This agent'} keeps its own context and does not share its size with ORBIX.`), costRows());
      return finish();
    }
    const parts = (u.breakdown || []).filter((r) => r.tokens > 0);
    // Each part is drawn against the limit when it is known, so the empty end of the bar is the room left.
    const base = cw || u.tokens || 1;
    const share = (tokens) => (tokens / base) * 100;
    const bar = h('div', { class: `cx-seg ${level}`.trim(), role: 'meter', 'aria-label': cw ? 'Context window used' : 'Context by part', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, Math.round(share(u.tokens) * 10) / 10)), 'aria-valuetext': cw ? `${percentText(u.percent)} of ${number(cw)} tokens` : `${number(u.tokens)} tokens` },
      parts.map((r) => {
        const s = h('i', { 'data-key': r.key });
        s.style.width = `${Math.min(100, share(r.tokens))}%`;
        return s;
      }));
    replace(body,
      h('div', { class: 'cx-use' },
        h('p', { class: 'cx-total num', title: cw ? `${number(u.tokens)} of ${number(cw)} tokens` : `${number(u.tokens)} tokens` }, h('b', null, `${approx}${fmtTokens(u.tokens)}`), cw ? ` of ${fmtTokens(cw)} tokens` : ' tokens'),
        h('p', { class: 'cx-src' }, sourceText(u))),
      bar,
      level ? h('p', { class: `cx-warn ${level}` }, level === 'crit' ? 'Almost full. Compact to keep going.' : 'Filling up.') : null,
      parts.length ? h('section', { class: 'cx-parts', 'aria-label': 'Breakdown' },
        h('div', { class: 'cx-sub' }, h('h3', null, 'Breakdown'), h('span', null, cw ? 'approximate, share of the limit' : 'approximate, share of what is used')),
        h('ul', { class: 'cx-rows' }, parts.map((r) => h('li', null,
          h('span', { class: 'cx-sw', 'data-key': r.key, 'aria-hidden': 'true' }),
          h('span', { class: 'cx-l' }, label(r.key)),
          h('span', { class: 'cx-n num', title: `${number(r.tokens)} tokens` }, `~${fmtTokens(r.tokens)}`),
          h('span', { class: 'cx-p num' }, percentText(share(r.tokens))))))) : null,
      costRows(u));
    finish();
  }
  function costRows(u) {
    const report = u?.lastRequest;
    const known = Number.isFinite(stats?.cost);
    return h('dl', { class: 'cx-stats' },
      h('div', { class: 'cx-stat cx-cost' }, h('dt', null, 'Session cost'), h('dd', { class: `num${known ? '' : ' na'}`, title: known ? '' : 'The provider did not report a price for this session.' }, known ? costText(stats.cost) : 'Not reported')),
      report ? h('div', { class: 'cx-stat' }, h('dt', null, 'Last request'), h('dd', { class: 'num', title: report.model }, `${number(report.input)} input, ${number(report.output)} output`)) : null);
  }
  function finish() {
    updateActions();
    pop.el._place?.();
  }

  async function load() {
    const mine = ++seq;
    failed = '';
    loading = true;
    if (!stats) replace(body, skeleton(3));
    updateActions();
    try {
      const reply = await rpc(tab.id, { type: 'get_context_budget' });
      if (current !== state || mine !== seq) return;
      stats = { ...(stats || {}), ...reply.data };
      if (reply.data?.contextUsage) tab.stats = { ...(tab.stats || {}), contextUsage: reply.data.contextUsage };
      loading = false;
      render();
    } catch (e) {
      if (current !== state || mine !== seq) return;
      loading = false;
      if (stats) return render();
      failed = e.message;
      badge.textContent = '';
      replace(body, errorState(e.message, { title: 'Couldn’t read context usage.', retry: load }));
      finish();
    }
  }

  // A turn or a compaction that ends while the panel is open changes the numbers and the cost: ask again.
  let wasBusy = !!(tab.streaming || tab.compacting);
  function refresh(useStats) {
    const busy = !!(tab.streaming || tab.compacting);
    const ended = wasBusy && !busy;
    wasBusy = busy;
    if (ended) return load();
    if (useStats && !loading && !failed && tab.stats?.contextUsage) {
      stats = { ...(stats || {}), ...tab.stats };
      render();
    } else updateActions();
  }
  if (stats) render();
  load();
}

// ================= the meter: one button, in the toolbar and in the message box =================

const SVG = 'http://www.w3.org/2000/svg';
const RING = 2 * Math.PI * 6;

/** Whether the conversation has a measured context. */
const hasUsage = (tab) => {
  const u = tab?.stats?.contextUsage;
  return !!u && u.tokens > 0;
};

/**
 * A small ring and the percent used. A click opens the context panel on the conversation `getTab()` returns.
 * `cls` places it (`tb-ctx` in the toolbar, `c-ctx` in the message box). With `always`, it stays in view for a
 * conversation whose agent does not share its context (the panel still has its cost); otherwise it hides until
 * there is a measured context. `update()` redraws it from the conversation's stats.
 */
export function contextMeter(getTab, onDetails, { cls = '', always = false } = {}) {
  const arc = document.createElementNS(SVG, 'circle');
  const track = document.createElementNS(SVG, 'circle');
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const c of [track, arc]) (c.setAttribute('cx', '8'), c.setAttribute('cy', '8'), c.setAttribute('r', '6'), svg.append(c));
  track.setAttribute('class', 'ring-track');
  arc.setAttribute('class', 'ring-arc');
  const text = h('span', { class: 'ctx-meter-p num', 'aria-hidden': 'true' });
  const el = h('button', { class: `ctx-meter ${cls}`.trim(), type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, svg, text);
  el.addEventListener('click', () => {
    const tab = getTab();
    if (tab && !tab.dead) openContextBudget(el, tab, onDetails);
  });
  let sig = null;
  const update = () => {
    const tab = getTab();
    const measured = hasUsage(tab);
    const show = !!tab && !tab.dead && (measured || always);
    el.hidden = !show;
    if (!show) return (sig = null);
    const u = measured ? tab.stats.contextUsage : null;
    const pct = u && Number.isFinite(u.percent) ? Math.min(100, u.percent) : null;
    const next = u ? `${pct == null ? '' : pct.toFixed(2)}:${u.tokens}:${u.contextWindow || 0}:${!!u.reported}` : 'none';
    if (next === sig) return;
    sig = next;
    const level = contextLevel(pct);
    el.classList.toggle('hot', level === 'hot');
    el.classList.toggle('crit', level === 'crit');
    el.classList.toggle('none', !u);
    // The arc is the true share: under 1% it is a dot (the round cap), never padded up to look fuller.
    arc.setAttribute('stroke-dasharray', `${Math.max(0.01, (RING * (pct || 0)) / 100).toFixed(2)} ${RING.toFixed(2)}`);
    arc.style.visibility = pct ? '' : 'hidden';
    text.textContent = !u ? '' : pct == null ? fmtTokens(u.tokens) : percentText(pct);
    const tip = !u ? 'Context and cost'
      : u.contextWindow ? `Context: ${fmtTokens(u.tokens)} of ${fmtTokens(u.contextWindow)} tokens (${percentText(pct)})${u.reported ? '' : ', estimated'}`
      : `Context: ${fmtTokens(u.tokens)} tokens, limit unknown`;
    el.title = tip;
    el.setAttribute('aria-label', tip);
  };
  update();
  return { el, update };
}

on('active', () => { if (current && current.tab !== activeTab()) current.close(false); });
on('tab:state', (tab) => { if (current?.tab === tab) current.update(true); });
for (const event of ['tab:status', 'tab:dialog']) on(event, (tab) => { if (current?.tab === tab) current.update(false); });
