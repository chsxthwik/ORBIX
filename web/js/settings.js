// Settings: a full-size sheet. Overview, then the agent (providers, models, permissions, tools), then the app.
// A search box finds any setting by name and jumps to it.
import { h, icon, toast, replace, clear, logo } from './dom.js';
import { api } from './api.js';
import { S, savePrefs, engineReady, loadEngine, loadEnv, loadSessions, emit } from './store.js';
import { modal, btn, confirmDialog, shortcutsDialog, row, toggle } from './dialogs.js';
import { renderEngineSettings } from './engine.js';
import { brandMark } from './brands.js';
import { renderModelRoles } from './models.js';
import { renderMcpSettings } from './mcp.js';
import { openHelp } from './help.js';
import { openDiagnostics } from './diagnostics.js';

/** key, label, icon, one line under the page title. */
const TABS = [
  ['start', 'Overview', 'compass', 'How ORBIX is set up right now.'],
  { group: 'Agent' },
  ['engine', 'Providers', 'key', 'Connect an API key or a local model. Keys are checked, stored encrypted for your Windows account, and sent only to that provider.'],
  ['models', 'Models', 'cpu', 'Choose which model does which job.'],
  ['behavior', 'Permissions', 'shield', 'What the agent may do without asking, and where it runs commands.'],
  ['tools', 'Tools & MCP', 'plug', 'What the agent can use, and the extra tools you add.'],
  { group: 'App' },
  ['look', 'Appearance', 'palette', 'Theme and text size.'],
  ['about', 'About', 'info', 'Version, help and shortcuts.'],
];
const PAGES = TABS.filter((t) => Array.isArray(t));

/** What the search box can find: [setting, page, extra words]. */
const FIND = [
  ['API keys', 'engine', 'provider key anthropic openai gemini openrouter connect'],
  ['Local models', 'engine', 'ollama lm studio offline server custom'],
  ['Fast model', 'models', 'titles summaries helper agents cheap'],
  ['Plan model', 'models', 'plan mode'],
  ['File edits and commands', 'behavior', 'approval ask allow permission auto'],
  ['Run commands in', 'behavior', 'shell wsl windows powershell kali'],
  ['Follow new output', 'behavior', 'scroll auto'],
  ['Web search', 'tools', 'brave tavily searxng'],
  ['MCP servers', 'tools', 'server tools mcp'],
  ['Hooks', 'tools', 'before after tool'],
  ['Theme', 'look', 'dark light system midnight frost color'],
  ['Message text size', 'look', 'font zoom'],
  ['Show model thinking', 'look', 'reasoning'],
  ['Keyboard shortcuts', 'about', 'keys hotkeys'],
];

/** Rows that belong together, in one framed list. */
export const group = (title, note, ...rows) => h('section', { class: 'set-group' }, title ? h('h4', { class: 'set-sub' }, title) : null, note ? h('p', { class: 'set-note' }, note) : null, h('div', { class: 'set-card' }, ...rows));

/** Open Settings on a page: start, engine, models, behavior, tools, look, about. */
export function openSettings(initial = 'start') {
  let cur = PAGES.some(([k]) => k === initial) ? initial : 'start';
  const results = h('div', { class: 'set-results', hidden: true, role: 'listbox', 'aria-label': 'Matching settings' });
  const list = h('div', { class: 'set-pages', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings pages' });
  const search = h('input', { type: 'search', class: 'set-search', placeholder: 'Find a setting', 'aria-label': 'Find a setting', spellcheck: 'false', autocomplete: 'off' });
  const nav = h('nav', { class: 'set-nav' }, h('div', { class: 'set-find' }, icon('search', 14), search), results, list);
  const content = h('div', { class: 'set-content', role: 'tabpanel', tabindex: '-1' });
  const m = modal({ title: 'Settings', size: 'xl', cls: 'settings', body: h('div', { class: 'set-wrap' }, nav, content) });

  const badge = (k) => {
    if (k !== 'engine') return null;
    const n = (S.engine?.providers || []).filter((p) => p.configured).length;
    return n ? h('span', { class: 'set-n num' }, String(n)) : h('span', { class: 'dot warn', title: 'No model connected' });
  };
  const drawNav = () => replace(list, TABS.map((t) => t.group
    ? h('div', { class: 'set-nav-h' }, t.group)
    : h('button', { type: 'button', role: 'tab', id: `set-${t[0]}`, 'aria-selected': String(t[0] === cur), tabindex: t[0] === cur ? '0' : '-1', class: 'set-tab' + (t[0] === cur ? ' cur' : ''), onclick: () => show(t[0]) }, icon(t[2], 15), h('span', { class: 'ell grow' }, t[1]), badge(t[0]))));

  const show = (name, focusNav) => {
    cur = name;
    drawNav();
    list.querySelector('.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    content.setAttribute('aria-labelledby', `set-${name}`);
    clear(content);
    content.scrollTop = 0;
    const page = PAGES.find(([k]) => k === name);
    const body = h('div', { class: 'set-body' });
    content.append(h('header', { class: 'set-head' }, h('h3', { class: 'set-title' }, page[1]), h('p', { class: 'set-lead' }, page[3])), body);
    ({ start: tabStart, engine: renderEngineSettings, models: tabModels, look: tabLook, behavior: tabBehavior, tools: renderMcpSettings, about: tabAbout })[name](body, show, m);
    if (focusNav) list.querySelector('.cur')?.focus();
  };

  /** Open the setting's page and point at it once it has drawn (some pages load their rows). */
  const jump = ([label, page]) => {
    search.value = '';
    filter();
    show(page);
    const t0 = Date.now();
    const seek = () => {
      const el = [...content.querySelectorAll('.set-l, .set-sub, .perm-t')].find((x) => x.textContent === label);
      if (el) {
        const box = el.closest('.set-row, .set-group, .perm') || el;
        box.scrollIntoView({ block: 'center' });
        box.classList.add('set-flash');
      } else if (Date.now() - t0 < 1200) requestAnimationFrame(seek);
    };
    requestAnimationFrame(seek);
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    results.hidden = !q;
    list.hidden = !!q;
    if (!q) return replace(results);
    const hits = FIND.filter(([l, p, w]) => `${l} ${w} ${PAGES.find(([k]) => k === p)[1]}`.toLowerCase().includes(q));
    replace(results, hits.length ? hits.map((f) => h('button', { class: 'set-hit', type: 'button', role: 'option', onclick: () => jump(f) }, h('span', { class: 'ell' }, f[0]), h('small', null, PAGES.find(([k]) => k === f[1])[1]))) : h('p', { class: 'set-none' }, 'No setting matches.'));
  };
  search.addEventListener('input', filter);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') results.querySelector('.set-hit')?.click();
    if (e.key === 'Escape' && search.value) (e.stopPropagation(), e.preventDefault(), (search.value = ''), filter());
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = PAGES.findIndex(([k]) => k === cur);
    show(PAGES[(i + (e.key === 'ArrowDown' ? 1 : -1) + PAGES.length) % PAGES.length][0], true);
  });
  show(cur);
  setTimeout(() => list.querySelector('.cur')?.focus({ preventScroll: true }), 0);
  return m;
}

// ================= overview =================

function tabStart(el, show, m) {
  const ready = engineReady();
  const connected = (S.engine?.providers || []).filter((p) => p.configured);
  const on = connected.map((p) => p.name);
  const auto = S.engine?.approvals === 'auto';
  const b = S.env.backend;
  const search = !!S.engine?.search?.configured;
  const tile = (ic, name, value, tone, page) => h('button', { class: 'ov-tile', type: 'button', onclick: () => show(page) },
    h('span', { class: 'ov-ic' }, typeof ic === 'string' ? icon(ic, 16) : ic),
    h('span', { class: 'ov-m' }, h('span', { class: 'ov-k' }, name), h('span', { class: 'ov-v ell' }, value)),
    h('span', { class: `dot ${tone}`.trim() }));
  el.append(
    ready ? '' : h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'Connect a model to start'), h('p', null, 'An API key or a local model. Nothing else to install.')), btn('Connect a model', () => show('engine'), 'primary')),
    h('div', { class: 'ov-grid' },
      tile(connected[0] ? brandMark(connected[0].id, 18) : 'key', 'Model', ready ? on.join(', ') : 'Not connected', ready ? 'ok' : 'warn', 'engine'),
      tile('shield', 'Permissions', auto ? 'Allows everything' : 'Asks first', auto ? 'warn' : 'ok', 'behavior'),
      tile('terminal', 'Commands run in', b.kind === 'wsl' ? (b.distro ? `WSL · ${b.distro}` : 'WSL') : 'Windows', '', 'behavior'),
      tile('globe', 'Web search', search ? 'Connected' : 'Optional, not set up', search ? 'ok' : '', 'tools')),
    h('div', { class: 'set-actions' },
      btn('New session', () => {
        m.close();
        emit('home');
      }, ready ? 'primary' : ''),
      btn('Check my setup', () => openDiagnostics()),
      btn('How ORBIX works', () => openHelp())));
}

// ================= models =================

async function tabModels(el, show) {
  try {
    const { engine } = await api.get('/api/engine');
    if (!engine.providers.some((p) => p.configured)) {
      el.append(h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'No model connected yet'), h('p', null, 'Connect a provider first, then choose models here.')), btn('Open providers', () => show('engine'), 'primary')));
      return;
    }
    const roles = h('div', { class: 'roles' });
    el.append(roles);
    renderModelRoles(roles, engine);
  } catch (e) {
    el.append(h('div', { class: 'callout bad' }, e.message));
  }
}

// ================= appearance =================

function tabLook(el) {
  const u = S.ui;
  const theme = u.theme || 'system';
  const themes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight'], ['frost', 'Frost']].map(([v, l]) => h('button', { class: 'theme-c', type: 'button', role: 'radio', 'aria-checked': String(theme === v), onclick: (e) => {
    const apply = () => savePrefs({ theme: v });
    // A soft crossfade between themes.
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
    else apply();
    for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
  } }, h('span', { class: `theme-p ${v}`, 'aria-hidden': 'true' }, h('i'), h('b'), h('u')), h('span', { class: 'theme-n' }, l))));
  const val = h('span', { class: 'num range-v' }, `${u.fontSize || 14}px`);
  const size = h('input', { type: 'range', min: 12, max: 18, step: 1, value: u.fontSize || 14, 'aria-label': 'Message text size', oninput: () => ((val.textContent = size.value + 'px'), savePrefs({ fontSize: +size.value })) });
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Theme'), themes),
    group('Reading', null,
      row('Message text size', h('div', { class: 'row' }, size, val)),
      h('p', { class: 'fs-sample' }, 'The quick brown fox: this is how replies will read.'),
      row('Show model thinking', toggle(u.showThinking !== false, (v) => savePrefs({ showThinking: v }), 'Show model thinking'), 'Show the model’s reasoning in replies, collapsed.')));
}

// ================= permissions =================

function tabBehavior(el) {
  const auto = S.engine?.approvals === 'auto';
  const set = async (value, card) => {
    if (value === 'auto' && !(await confirmDialog('Allow everything', 'The agent will edit files and run commands without asking. Every file edit can still be undone, but commands cannot.', { ok: 'Allow everything', danger: true }))) return;
    try {
      await api.post('/api/engine/settings', { approvals: value });
      await loadEngine();
      for (const b of card.parentElement.children) b.setAttribute('aria-checked', String(b === card));
      toast('Saved', 'ok', 1200);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const choice = (value, ic, title, text, on, tag) => h('button', { class: `perm is-${value}`, type: 'button', role: 'radio', 'aria-checked': String(on), onclick: (e) => e.currentTarget.getAttribute('aria-checked') !== 'true' && set(value, e.currentTarget) },
    h('span', { class: 'perm-ic' }, icon(ic, 16)),
    h('span', { class: 'perm-m' }, h('span', { class: 'perm-h' }, h('span', { class: 'perm-t' }, title), tag ? h('span', { class: 'tag' }, tag) : null), h('span', { class: 'perm-d' }, text)),
    h('span', { class: 'perm-r', 'aria-hidden': 'true' }));
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'File edits and commands'), h('p', { class: 'set-note' }, 'Reading and searching never ask.'),
      h('div', { class: 'perms', role: 'radiogroup', 'aria-label': 'File edits and commands' },
        choice('ask', 'shield', 'Ask me first', 'Each edit and command waits for your OK.', !auto, 'Recommended'),
        choice('auto', 'bolt', 'Allow everything', 'Edits and commands run without asking.', auto))),
    group('Running', null, whereRow(), row('Follow new output', toggle(S.ui.autoScroll !== false, (v) => savePrefs({ autoScroll: v }), 'Follow new output'), 'Scroll to the newest text while it streams, unless you scrolled up.')));
}

/** Where the agent runs shell commands: Windows, or one of the installed WSL distributions. */
function whereRow() {
  const b = S.env.backend;
  const cur = b.kind === 'wsl' ? 'wsl|' + b.distro : 'native|';
  const sel = h('select', { 'aria-label': 'Run commands in' }, h('option', { value: 'native|' }, 'Windows'), b.kind === 'wsl' ? h('option', { value: cur }, (b.distro ? `WSL · ${b.distro}` : 'WSL · default distribution')) : null);
  sel.value = cur;
  api.get('/api/env').then((env) => {
    for (const d of env.distros || []) if (!sel.querySelector(`option[value="wsl|${CSS.escape(d)}"]`)) sel.append(h('option', { value: 'wsl|' + d }, `WSL · ${d}`));
    sel.value = cur;
  }).catch(() => {});
  sel.addEventListener('change', async () => {
    const [kind, distro] = sel.value.split('|');
    try {
      await api.post('/api/backend', { kind, distro });
      await loadEnv();
      loadSessions();
      emit('env');
      emit('prefs', {});
      toast('Saved. New sessions run commands there.', 'ok', 3500);
    } catch (e) {
      toast(e.message, 'error');
      sel.value = cur;
    }
  });
  return row('Run commands in', sel, 'From WSL, Windows drives appear as /mnt/c, /mnt/d and so on.');
}

// ================= about =================

function tabAbout(el) {
  const b = S.env.backend;
  el.append(
    h('div', { class: 'about-h' }, logo(38), h('div', null, h('strong', null, 'ORBIX'), h('p', null, `Version ${S.env.app.version}`))),
    group(null, null,
      row('Commands run in', b.kind === 'wsl' ? `WSL (${b.distro})` : 'Windows'),
      row('Keyboard shortcuts', btn('Show', () => shortcutsDialog(), 'sm')),
      row('How ORBIX works', btn('Open', () => openHelp(), 'sm')),
      row('Quit ORBIX', btn('Quit', async () => {
        if (await confirmDialog('Quit ORBIX', 'Stop all sessions and close ORBIX?', { ok: 'Quit', danger: true })) {
          await api.post('/api/quit').catch(() => {});
          window.chrome?.webview?.postMessage('quit'); // the native window closes itself
        }
      }, 'sm danger'), 'Stops every running session.')));
}
