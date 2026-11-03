// Status bar: live, measured numbers only. Agent state and turn time, tokens, cost, tool calls,
// git branch and changes, and where commands run. (Model and context use sit in the composer.)
import { h, $, icon, fmtTokens, fmtCost } from './dom.js';
import { S, on, activeTab, ompInstalled } from './store.js';
import { gitState } from './panels.js';

let bar;
let ticker;

const sep = (cls = '') => h('span', { class: `sb-sep ${cls}`.trim(), 'aria-hidden': 'true' });
const fmtElapsed = (sec) => (sec < 60 ? sec + 's' : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);

function drawStatus() {
  const t = activeTab();
  const b = S.env?.backend;
  const busy = !!t?.streaming;
  const offline = S.connected === false;
  const where = b ? (b.kind === 'wsl' ? `WSL · ${b.distro || '?'}` : 'Windows') : '';
  const state = offline ? 'Reconnecting…' : busy ? 'Working' : t?.dead ? 'Session ended' : t ? 'Ready' : S.tabs.size ? `${S.tabs.size} session${S.tabs.size === 1 ? '' : 's'} open` : 'Ready';
  const dot = offline ? ' warn' : busy ? ' run' : t?.dead ? ' dead' : ' ok';
  const left = [h('span', { class: 'sb-item' }, h('span', { class: 'dot' + dot }), h('span', { id: 'sb-state' }, state))];

  if (t && !t.dead) {
    const tk = t.stats?.tokens;
    if (tk?.total) {
      const input = (tk.input || 0) + (tk.cacheRead || 0) + (tk.cacheWrite || 0);
      left.push(sep('sb-opt'), h('span', { class: 'sb-item sb-opt num', title: `Tokens this session: ${tk.input || 0} input, ${tk.cacheRead || 0} cache read, ${tk.cacheWrite || 0} cache write, ${tk.output || 0} output` }, `${fmtTokens(input)} in · ${fmtTokens(tk.output || 0)} out`));
    }
    if (t.stats?.cost) left.push(h('span', { class: 'sb-item sb-opt num', title: 'Cost of this session' }, fmtCost(t.stats.cost)));
    if (t.stats?.toolCalls) left.push(h('span', { class: 'sb-item sb-opt num', title: 'Tool calls in this session' }, `${t.stats.toolCalls} tool call${t.stats.toolCalls === 1 ? '' : 's'}`));
  }

  const right = [];
  const g = t && gitState(t.workspace);
  if (g?.repo) {
    const n = g.files?.length || 0;
    right.push(h('span', { class: 'sb-item', title: `${t.workspace}\nBranch ${g.branch}${g.upstream ? ' → ' + g.upstream : ''}${n ? ` · ${n} changed file${n === 1 ? '' : 's'}` : ''}` }, icon('branch', 12), h('span', { class: 'ell' }, g.branch || 'detached'), n ? h('b', { class: 'num' }, `${n} changed`) : null), sep('sb-opt'));
  } else if (t) right.push(h('span', { class: 'sb-item sb-path', title: t.workspace }, icon('folder', 12), h('bdi', { class: 'ell' }, t.workspace)), sep('sb-opt'));
  if (where) right.push(h('span', { class: 'sb-item sb-opt', title: 'Where the agent runs commands' }, icon('terminal', 12), where));
  if (t && ompInstalled()) right.push(sep('sb-opt'), h('span', { class: 'sb-item sb-opt' }, t.engine === 'builtin' ? 'ORBIX agent' : 'OMP CLI'));

  bar.replaceChildren(...left, h('span', { class: 'grow' }), ...right);
  clearInterval(ticker);
  if (busy && !offline) {
    const tick = () => {
      const el = $('#sb-state');
      if (el) el.textContent = `Working ${fmtElapsed(Math.max(0, Math.floor((Date.now() - (t.turnStartedAt || Date.now())) / 1000)))}`;
    };
    tick();
    ticker = setInterval(tick, 1000);
  }
}

export function initStatusBar() {
  bar = $('#statusbar');
  const refresh = () => drawStatus();
  for (const ev of ['active', 'tabs', 'env', 'git']) on(ev, refresh);
  for (const ev of ['tab:status', 'tab:state']) on(ev, (t) => (!t || t === activeTab()) && refresh());
  refresh();
}
