import { rpc } from './api.js';
import { btn, popover } from './dialogs.js';
import { errorState, h, replace, skeleton, toast } from './dom.js';
import { activeTab, on } from './store.js';

export const contextLevel = (percent) => percent >= 95 ? 'crit' : percent >= 80 ? 'hot' : '';
const percentText = (n) => `${n < 1 || n % 1 ? n.toFixed(1) : n}%`;
const number = (n) => n.toLocaleString();
const costText = (n) => !Number.isFinite(n) ? 'Not reported' : n > 0 && n < 0.0001 ? '<$0.0001' : `$${n.toFixed(n < 1 ? 4 : 2)}`;
const labels = { system: 'System prompt', rules: 'Project rules', files: 'Files attached', history: 'Conversation history', results: 'Tool results' };

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

let current;
export function openContextBudget(anchor, tab, openDetails) {
  if (current?.tab === tab) return current.close();
  current?.close(false);
  const heading = h('h2', { class: 'ctx-pop-title', tabindex: '-1' }, 'Context and cost');
  const body = h('div', {}, skeleton(4));
  const reason = h('p', { class: 'muted small' });
  const outcome = h('p', { class: 'ctx-pop-outcome small', role: 'status' });
  const compact = btn('Compact now', () => requestCompaction(tab), 'sm primary');
  const info = btn('Context details', () => { pop.close(false); openDetails(); }, 'sm');
  compact.disabled = true;
  let stats, loading = true;
  const pop = popover(anchor, h('div', { class: 'ctx-pop-body' }, heading, body,
    h('div', { class: 'ctx-pop-actions' }, compact, info), reason, outcome), {
    align: 'end', cls: 'ctx-popover', label: 'Context and cost',
    onClose: () => {
      anchor.setAttribute('aria-expanded', 'false');
      if (current === state) current = null;
    },
  });
  const state = { ...pop, tab, update: refresh };
  current = state;
  anchor.setAttribute('aria-expanded', 'true');
  heading.focus({ preventScroll: true });

  function updateActions() {
    const blocked = compactBlock(tab, stats);
    compact.disabled = loading || !stats || !!blocked;
    reason.textContent = blocked || 'Uses a model call to summarize older turns. The last six stay verbatim.';
    const result = tab.compactionResult;
    const r = result?.result;
    outcome.textContent = result?.error ? `Couldn’t compact: ${result.error}` : r
      ? r.tokensSaved > 0 ? `About ${number(r.tokensSaved)} tokens saved (${number(r.tokensBefore)} → ${number(r.tokensAfter)}).` : 'Compacted, but the estimate did not decrease.'
      : '';
  }

  function render() {
    const u = stats?.contextUsage;
    const cw = u?.contextWindow;
    const level = contextLevel(u?.percent);
    const report = u?.lastRequest;
    replace(body,
      h('p', { class: 'ctx-pop-total num' }, u ? `${u.estimated ? '~' : ''}${number(u.tokens)}${cw ? ` / ${number(cw)}` : ''} tokens${cw ? ` · ${percentText(u.percent)}` : ''}` : 'Context breakdown unavailable'),
      contextBar(u),
      level ? h('p', { class: `${level === 'crit' ? 'err-text' : 'warn-text'} small` }, level === 'crit' ? 'Nearly full: 95% or more.' : 'Filling up: 80% or more.') : null,
      u ? h('dl', { class: 'ctx-pop-list' }, u.breakdown.map((r) =>
        h('div', null, h('dt', null, labels[r.key]), h('dd', { class: 'num' }, `~${number(r.tokens)}${cw ? ` · ${percentText(r.tokens / cw * 100)}` : ''}`)))) :
        h('p', { class: 'muted small' }, `${stats.contextOwner || 'This agent'} does not expose its assembled context to ORBIX.`),
      h('div', { class: 'ctx-pop-cost' }, h('span', null, 'Session cost'), h('strong', { class: 'num' }, costText(stats.cost))),
      report ? h('p', { class: 'muted small num' }, `Last provider report (${report.model}): ${number(report.input)} input, ${number(report.output)} output.`) : null,
      u ? h('p', { class: 'muted small' }, `Breakdown estimated. System includes tool definitions; only sent files count.${u.windowEstimated ? ' Model window estimated.' : ''}`) : null,
      Number.isFinite(stats.cost) ? h('p', { class: 'muted small' }, 'Session cost excludes requests without a reported or known price.') : null);
    updateActions();
    pop.el._place?.();
  }

  async function load() {
    loading = true;
    replace(body, skeleton(4));
    updateActions();
    try {
      const reply = await rpc(tab.id, { type: 'get_context_budget' });
      if (current !== state) return;
      stats = reply.data;
      loading = false;
      render();
    } catch (e) {
      if (current !== state) return;
      loading = false;
      replace(body, errorState(e.message, { title: 'Couldn’t read context usage.', retry: load }));
      updateActions();
      pop.el._place?.();
    }
  }

  function refresh(useStats) {
    if (useStats && !loading && stats?.contextUsage && tab.stats?.contextUsage) {
      stats = { ...stats, ...tab.stats };
      render();
    } else updateActions();
  }
  load();
}

on('active', () => { if (current && current.tab !== activeTab()) current.close(false); });
on('tab:state', (tab) => { if (current?.tab === tab) current.update(true); });
for (const event of ['tab:status', 'tab:dialog']) on(event, (tab) => { if (current?.tab === tab) current.update(false); });
