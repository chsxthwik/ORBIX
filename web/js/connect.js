// Connect: one dialog for what ORBIX can work with. Providers (an API key, a sign-in or a model server on this PC)
// and the agent CLIs found on this computer, each connected in place. Opened from the model picker, the command
// palette, the Workspace menu and Ctrl+Shift+M; the same lists live in Settings → Providers and Settings → Agents.
import { h } from './dom.js';
import { modal } from './dialogs.js';
import { renderEngineSettings } from './engine.js';
import { tabAgents } from './agents.js';

let open = null;

/** Open the Connect dialog on `page` ('providers' or 'agents'). */
export function openConnect(page = 'providers') {
  if (open?.el?.isConnected) return open.show(page);
  const panes = { providers: h('div', { class: 'cn-pane' }), agents: h('div', { class: 'cn-pane' }) };
  const tabs = h('div', { class: 'seg cn-seg', role: 'tablist', 'aria-label': 'Connect' },
    [['providers', 'Providers'], ['agents', 'Agents']].map(([id, label]) => h('button', { type: 'button', role: 'tab', dataset: { id }, onclick: () => show(id) }, label)));
  const loaded = new Set();
  const show = (id) => {
    for (const b of tabs.children) {
      b.setAttribute('aria-selected', String(b.dataset.id === id));
      b.setAttribute('aria-checked', String(b.dataset.id === id));
    }
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== id;
    if (!loaded.has(id)) {
      loaded.add(id);
      if (id === 'providers') renderEngineSettings(panes.providers);
      else tabAgents(panes.agents, null, m);
    }
    panes[id].querySelector('input[type=search], button')?.focus({ preventScroll: true });
  };
  const m = modal({
    title: 'Connect',
    cls: 'connect-dlg',
    body: [h('div', { class: 'cn-top' }, h('p', { class: 'cn-sub' }, 'Models and agents ORBIX can use. Keys stay encrypted on this PC.'), tabs), panes.providers, panes.agents],
    onClose: () => (open = null),
  });
  open = { el: m.el, show };
  show(page);
  return open;
}
