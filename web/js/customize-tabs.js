// The tab strip of the Customize page: Plugins, Skills, Loops and Review, one page with four tabs. Each page draws it
// under its own title, so a click only has to ask for the other page; the Review tab carries what waits for you.
import { h } from './dom.js';
import { emit, on } from './store.js';
import { HUB_LINKS, CUSTOMIZE, lastCustomize } from './hub-nav.js';

/** How many decisions wait for you (runs.js sets it, so this file does not depend on it). */
export const waiting = { count: () => 0 };

export function customizeTabs(current) {
  lastCustomize.view = current;
  const keys = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...e.currentTarget.querySelectorAll('[role=tab]')];
    const next = tabs[(tabs.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    e.preventDefault();
    next.focus();
    next.click();
  };
  return h('div', { class: 'cust-tabs', role: 'tablist', 'aria-label': 'Customize', onkeydown: keys },
    CUSTOMIZE.map((view) => {
      const link = HUB_LINKS.find((x) => x.view === view);
      const n = view === 'review' ? waiting.count() : 0;
      return h('button', { class: 'cust-tab', type: 'button', role: 'tab', dataset: { view }, 'aria-selected': String(view === current), tabindex: view === current ? '0' : '-1', title: link.hint, onclick: () => view !== current && emit('hub:go', view) },
        link.label, n ? h('span', { class: 'cust-n num', 'aria-label': `${n} waiting for you` }, n) : null);
    }));
}

// What waits for you changes while a Customize page is open: every Review tab on screen follows.
const syncBadges = () => {
  for (const tab of document.querySelectorAll('.cust-tab[data-view=review]')) {
    const n = waiting.count();
    let badge = tab.querySelector('.cust-n');
    if (!n) badge?.remove();
    else {
      badge ||= tab.appendChild(h('span', { class: 'cust-n num' }));
      badge.textContent = String(n);
      badge.setAttribute('aria-label', `${n} waiting for you`);
    }
  }
};
on('runs', syncBadges);
on('tab:dialog', syncBadges);
