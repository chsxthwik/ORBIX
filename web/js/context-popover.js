import { rpc } from './api.js';
import { btn, popover } from './dialogs.js';
import { errorState, fmtTokens, h, replace, skeleton, toast } from './dom.js';
import { activeTab, on } from './store.js';

export const contextLevel = (percent) => percent >= 95 ? 'crit' : percent >= 80 ? 'hot' : '';
const percentText = (n) => `${n < 1 || n % 1 ? n.toFixed(1) : n}%`;
const number = (n) => n.toLocaleString();
const costText = (n) => !Number.isFinite(n) ? 'Not reported' : n > 0 && n < 0.0001 ? '<$0.0001' : `$${n.toFixed(n < 1 ? 4 : 2)}`;
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

/**
 * The context panel, opened from the toolbar meter or the message box's ring: how full the window is, a bar split
 * by part with a legend, the session cost, and Compact. One panel at a time; it follows the conversation's numbers.
 */
let current;
export function openContextBudget(anchor, tab, openDetails) {
  if (current?.tab === tab && current.anchor === anchor) return current.close();
  current?.close(false);
  const title = h('h2', { class: 'cx-title', tabindex: '-1' }, 'Context');
  const badge = h('span', { class: 'cx-badge num' });
  const body = h('div', { class: 'cx-main' }, skeleton(3));
  const outcome = h('p', { class: 'ctx-pop-outcome cx-outcome', role: 'status' });
  const compact = btn('Compact now', () => requestCompaction(tab), 'sm');
  const details = openDetails ? h('button', { class: 'cx-link', type: 'button', onclick: () => (pop.close(false), openDetails()) }, 'Details') : null;
  const foot = h('div', { class: 'cx-foot' }, details, h('span', { class: 'grow' }), compact);
  compact.disabled = true;
  let stats = tab.stats?.contextUsage ? { ...tab.stats } : null;
  let loading = !stats;
  const pop = popover(anchor, h('div', { class: 'cx-body' }, h('header', { class: 'cx-head' }, title, badge), body, outcome, foot), {
    align: 'end', cls: 'ctx-popover cx-pop', label: 'Context',
    onClose: () => {
      anchor.setAttribute('aria-expanded', 'false');
      if (current === state) current = null;
    },
  });
  const state = { ...pop, tab, anchor, update: refresh };
  current = state;
  anchor.setAttribute('aria-expanded', 'true');
  title.focus({ preventScroll: true });

  function updateActions() {
    const blocked = compactBlock(tab, stats);
    compact.disabled = loading || !stats || !!blocked;
    compact.title = blocked || 'Summarize older turns. The latest six stay as they are.';
    const r = tab.compactionResult?.result;
    const err = tab.compactionResult?.error;
    outcome.textContent = err ? `Couldn’t compact: ${err}` : r
      ? r.tokensSaved > 0 ? `${number(r.tokensSaved)} tokens saved (${number(r.tokensBefore)} → ${number(r.tokensAfter)})` : 'Compacted. The estimate did not decrease.'
      : '';
    outcome.classList.toggle('err', !!err);
  }

  function render() {
    const u = stats?.contextUsage;
    const cw = u?.contextWindow;
    const level = contextLevel(u?.percent);
    const approx = u?.estimated ? '~' : '';
    badge.textContent = u && Number.isFinite(u.percent) ? `${percentText(Math.round(u.percent * 10) / 10)} used` : '';
    badge.className = `cx-badge num ${level}`.trim();
    if (!u) {
      replace(body, h('p', { class: 'cx-empty' }, `${stats?.contextOwner || 'This agent'} doesn’t share its context with ORBIX.`), costRow());
      return finish();
    }
    const parts = (u.breakdown || []).filter((r) => r.tokens > 0);
    const base = cw || u.tokens || 1;
    const bar = h('div', { class: `cx-seg ${level}`.trim(), role: 'meter', 'aria-label': 'Context window used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, u.percent || 0)) },
      parts.map((r) => {
        const s = h('i', { 'data-key': r.key });
        s.style.width = `${Math.min(100, (r.tokens / base) * 100)}%`;
        return s;
      }));
    const used = parts.reduce((n, r) => n + r.tokens, 0) || 1;
    replace(body,
      h('p', { class: 'cx-total num' }, h('b', null, `${approx}${fmtTokens(u.tokens)}`), cw ? ` of ${fmtTokens(cw)} tokens` : ' tokens'),
      bar,
      level ? h('p', { class: `cx-warn ${level}` }, level === 'crit' ? 'Almost full. Compact to keep going.' : 'Filling up.') : null,
      h('ul', { class: 'ctx-pop-list cx-rows' }, parts.map((r) => h('li', null,
        h('span', { class: 'cx-sw', 'data-key': r.key, 'aria-hidden': 'true' }),
        h('span', { class: 'cx-l' }, label(r.key)),
        h('span', { class: 'cx-n num' }, `${approx}${fmtTokens(r.tokens)}`),
        h('span', { class: 'cx-p num' }, `${Math.round((r.tokens / used) * 100)}%`)))),
      costRow(u));
    finish();
  }
  function costRow(u) {
    const report = u?.lastRequest;
    return h('div', { class: 'cx-stats' },
      h('div', { class: 'ctx-pop-cost cx-stat' }, h('span', null, 'Session cost'), h('strong', { class: 'num' }, costText(stats?.cost))),
      report ? h('div', { class: 'cx-stat' }, h('span', null, 'Last request'), h('span', { class: 'num', title: report.model }, `${number(report.input)} input, ${number(report.output)} output`)) : null);
  }
  function finish() {
    updateActions();
    pop.el._place?.();
  }

  async function load() {
    if (!stats) replace(body, skeleton(3));
    updateActions();
    try {
      const reply = await rpc(tab.id, { type: 'get_context_budget' });
      if (current !== state) return;
      stats = { ...(stats || {}), ...reply.data };
      if (reply.data?.contextUsage) tab.stats = { ...(tab.stats || {}), contextUsage: reply.data.contextUsage };
      loading = false;
      render();
    } catch (e) {
      if (current !== state) return;
      loading = false;
      if (stats) return render();
      replace(body, errorState(e.message, { title: 'Couldn’t read context usage.', retry: load }));
      finish();
    }
  }

  function refresh(useStats) {
    if (useStats && !loading && tab.stats?.contextUsage) {
      stats = { ...(stats || {}), ...tab.stats };
      render();
    } else updateActions();
  }
  if (stats) render();
  load();
}

// ================= the composer's context ring =================

const SVG = 'http://www.w3.org/2000/svg';
const RING = 2 * Math.PI * 6;

/** Whether there is anything to show: a conversation with a measured context. */
const hasUsage = (tab) => {
  const u = tab?.stats?.contextUsage;
  return !!u && !tab.dead && u.tokens > 0 && Array.isArray(u.breakdown);
};

/**
 * A small ring in the message box's row showing how full the context is. Click opens "Context usage" above the
 * box: the total, a bar split by part, one row per part, and Compact. Hidden until the conversation has a measured
 * context. `update()` redraws it from tab.stats.
 */
export function contextRing(tab, onPanel) {
  const arc = document.createElementNS(SVG, 'circle');
  const track = document.createElementNS(SVG, 'circle');
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  for (const c of [track, arc]) (c.setAttribute('cx', '8'), c.setAttribute('cy', '8'), c.setAttribute('r', '6'), svg.append(c));
  track.setAttribute('class', 'ring-track');
  arc.setAttribute('class', 'ring-arc');
  arc.setAttribute('stroke-dasharray', `0 ${RING.toFixed(2)}`);
  const pctEl = h('span', { class: 'c-ctx-p num', 'aria-hidden': 'true' });
  const el = h('button', { class: 'c-ctx', type: 'button', hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => openContextBudget(el, tab, onPanel) }, svg, pctEl);
  let sig = '';
  const update = () => {
    const show = hasUsage(tab);
    el.hidden = !show;
    if (!show) return;
    const u = tab.stats.contextUsage;
    const pct = Number.isFinite(u.percent) ? Math.min(100, u.percent) : null;
    const next = `${pct?.toFixed(1)}:${u.tokens}`;
    if (next === sig) return;
    sig = next;
    const level = contextLevel(u.percent);
    el.classList.toggle('hot', level === 'hot');
    el.classList.toggle('crit', level === 'crit');
    arc.setAttribute('stroke-dasharray', `${((RING * Math.max(pct || 0, 4)) / 100).toFixed(2)} ${RING.toFixed(2)}`);
    pctEl.textContent = pct == null ? fmtTokens(u.tokens) : pct < 1 ? '<1%' : `${Math.round(pct)}%`;
    const text = pct != null ? `Context: ${Math.round(pct)}% used` : `Context: ${fmtTokens(u.tokens)} tokens`;
    el.title = text;
    el.setAttribute('aria-label', text);
  };
  update();
  return { el, update };
}

on('active', () => { if (current && current.tab !== activeTab()) current.close(false); });
on('tab:state', (tab) => { if (current?.tab === tab) current.update(true); });
for (const event of ['tab:status', 'tab:dialog']) on(event, (tab) => { if (current?.tab === tab) current.update(false); });
