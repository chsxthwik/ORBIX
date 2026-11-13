// Settings: a full-size sheet. Overview, then the agent (providers, models, permissions, tools), then the app.
// A search box finds any setting by name and jumps to it.
import { h, icon, toast, replace, clear, logo, errorState, loadingState } from './dom.js';
import { api } from './api.js';
import { S, on, savePrefs, engineReady, loadEngine, loadEnv, loadSessions, emit, groupSessions, activeTab } from './store.js';
import { toggleWide } from './workbench.js';
import { modal, btn, confirmDialog, row, toggle, SHORTCUTS, keyCaps } from './dialogs.js';
import { renderEngineSettings } from './engine.js';
import { brandMark } from './brands.js';
import { renderModelRoles } from './models.js';
import { renderMcpSettings } from './mcp.js';
import { openHelp } from './help.js';
import { openDiagnostics } from './diagnostics.js';
import { asciiComx } from './ascii.js';
import { homeProject } from './home.js';
import { updatesSupported, checkForUpdates, setAutoUpdates, restartToUpdate, updateLine } from './updates.js';

/** key, label, icon, one line under the page title. */
const TABS = [
  ['start', 'Overview', 'compass', 'How ORBIX is set up right now.'],
  { group: 'Agent' },
  ['engine', 'Providers', 'key', 'Sign in, paste an API key or connect a local model. Keys are checked, stored encrypted for your Windows account and sent only to their provider.'],
  ['models', 'Models', 'cpu', 'Choose which model does which job.'],
  ['behavior', 'Permissions', 'shield', 'What the agent may do without asking, the commands you trust, and where it runs commands.'],
  ['checks', 'Checks', 'check', 'How the agent checks its own work before it replies.'],
  ['rules', 'Instructions', 'file', 'What the agent should always know about you and how you work. It follows these in every project.'],
  ['tools', 'Tools & MCP', 'plug', 'What the agent can use, and the extra tools you add.'],
  { group: 'App' },
  ['look', 'Appearance', 'palette', 'Theme, text size and layout.'],
  ['keys', 'Shortcuts', 'keyboard', 'Every keyboard shortcut. Type to filter the list.'],
  ['about', 'About', 'info', 'Version, updates, developer and help.'],
];
const PAGES = TABS.filter((t) => Array.isArray(t));

/** What the search box can find: [setting, page, extra words]. */
const FIND = [
  ['API keys', 'engine', 'provider key anthropic openai gemini openrouter connect'],
  ['Local models', 'engine', 'ollama lm studio offline server custom'],
  ['Fast model', 'models', 'titles summaries helper agents cheap'],
  ['Plan model', 'models', 'plan mode'],
  ['File edits and commands', 'behavior', 'approval ask allow permission auto edits'],
  ['Trusted commands', 'behavior', 'allow always command npm test run trust'],
  ['Run the project’s check', 'checks', 'verify test tests lint build typecheck after edits'],
  ['Review the changes', 'checks', 'review diff self-review defects bugs'],
  ['Check command', 'checks', 'npm test pytest cargo go make verify project'],
  ['Instructions for every project', 'rules', 'agents.md rules memory preferences custom prompt'],
  ['Run commands in', 'behavior', 'shell wsl windows powershell kali'],
  ['Follow new output', 'behavior', 'scroll auto'],
  ['Web search', 'tools', 'brave tavily searxng'],
  ['MCP servers', 'tools', 'server tools mcp'],
  ['Hooks', 'tools', 'before after tool'],
  ['Theme', 'look', 'dark light system midnight frost color'],
  ['Message text size', 'look', 'font zoom bigger smaller'],
  ['Density', 'look', 'compact comfortable spacing rows'],
  ['Reading column', 'look', 'wide width'],
  ['Show model thinking', 'look', 'reasoning'],
  ['Keyboard shortcuts', 'keys', 'keys hotkeys'],
  ['Default model for new sessions', 'start', 'model home'],
  ['Updates', 'about', 'update upgrade new version check download install release'],
];

/** Rows that belong together, in one framed list. */
const group = (title, note, ...rows) => h('section', { class: 'set-group' }, title ? h('h4', { class: 'set-sub' }, title) : null, note ? h('p', { class: 'set-note' }, note) : null, h('div', { class: 'set-card' }, ...rows));

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
    ({ start: tabStart, engine: renderEngineSettings, models: tabModels, look: tabLook, behavior: tabBehavior, checks: tabChecks, tools: renderMcpSettings, rules: tabRules, keys: tabKeys, about: tabAbout })[name](body, show, m);
    if (focusNav) list.querySelector('.cur')?.focus();
  };

  /** Open the setting's page and point at it once it has drawn (some pages load their rows). */
  const jump = ([label, page]) => {
    search.value = '';
    filter();
    show(page);
    const t0 = Date.now();
    const seek = () => {
      const el = [...content.querySelectorAll('.set-l, .set-sub, .perm-t, .ov-l')].find((x) => x.textContent === label);
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
  const eng = S.engine || {};
  const connected = (eng.providers || []).filter((p) => p.configured);
  const auto = eng.approvals === 'auto';
  const b = S.env.backend;
  const roles = eng.models || {};
  const hm = S.ui.homeModel;
  const projects = groupSessions().filter((g) => g.path).length;
  const pins = (Array.isArray(S.ui.pinned) ? S.ui.pinned : []).filter((p) => S.sessions.some((x) => x.path === p)).length;
  const short = (v) => (v ? String(v).split('/').slice(1).join('/') || v : '');
  /** One line: what it is, how it is set now, and the page that changes it. */
  const line = (ic, label, value, page, tone = '') => h(page ? 'button' : 'div', { class: 'ov-row' + (page ? '' : ' static'), ...(page ? { type: 'button', onclick: () => show(page) } : {}) },
    h('span', { class: 'ov-ic' }, typeof ic === 'string' ? icon(ic, 15) : ic),
    h('span', { class: 'ov-l' }, label),
    h('span', { class: `ov-val ell ${tone}`.trim() }, value),
    page ? icon('chevron-right', 14, 'ov-go') : null);
  const card = (title, ...rows) => h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, title), h('div', { class: 'ov-card' }, ...rows));
  const mcp = line('plug', 'MCP servers', '…', 'tools');
  api.get('/api/mcp').then((j) => {
    const n = Object.keys(j.servers || {}).length;
    mcp.querySelector('.ov-val').textContent = n ? `${n} server${n === 1 ? '' : 's'}` : 'None added';
  }).catch(() => (mcp.querySelector('.ov-val').textContent = 'Not available'));

  el.append(
    ready ? '' : h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'Connect a model to start'), h('p', null, 'Use an API key, a sign-in or a model on this PC. Nothing else needs to be installed.')), btn('Connect a model', () => show('engine'), 'primary')),
    card('Agent',
      line(connected[0] ? brandMark(connected[0].id, 16) : 'key', 'Providers', ready ? connected.map((p) => (p.models != null ? `${p.name} · ${p.models} model${p.models === 1 ? '' : 's'}` : p.name)).join(', ') : 'None connected', 'engine', ready ? '' : 'warn'),
      line('message', 'Default model for new sessions', hm?.id ? hm.name || hm.id : 'Chosen on Home, under the task box', null),
      line('bolt', 'Fast model', roles.fast ? short(roles.fast) : 'Same as the session', 'models'),
      line('map', 'Plan model', roles.plan ? short(roles.plan) : 'Same as the session', 'models')),
    card('Safety',
      line('shield', 'File edits and commands', auto ? 'Run without asking' : eng.approvals === 'edits' ? 'Edits run, commands ask' : 'Ask me first', 'behavior', auto ? 'warn' : 'ok'),
      line('check', 'Trusted commands', (eng.trusted || []).length ? `${eng.trusted.length} command${eng.trusted.length === 1 ? '' : 's'}` : 'None', 'behavior'),
      line('check', 'Checks after edits', [{ off: 'Off', ask: 'Ask first', always: 'Always' }[eng.verify || 'ask'], eng.review === false ? 'no review' : 'with a review'].join(', '), 'checks'),
      line('terminal', 'Commands run in', b.kind === 'wsl' ? (b.distro ? `WSL · ${b.distro}` : 'WSL') : 'Windows', 'behavior')),
    card('Tools',
      line('globe', 'Web search', eng.search?.configured ? eng.search.provider || 'Connected' : 'Off', 'tools'),
      mcp),
    card('Your work',
      line('message', 'Conversations', String(S.sessions.length), null),
      line('folder', 'Projects', String(projects), null),
      line('check', 'Pinned in the sidebar', pins ? String(pins) : 'None yet. Select a conversation and press P, or right-click it.', null)),
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
  replace(el, loadingState('Loading your models…'));
  let engine;
  try {
    ({ engine } = await api.get('/api/engine'));
  } catch (e) {
    return replace(el, errorState(e.message, { title: 'Couldn’t load your models.', retry: () => tabModels(el, show) }));
  }
  if (!engine.providers.some((p) => p.configured)) {
    return replace(el, h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'No model is connected yet'), h('p', null, 'Connect a provider first, then choose your models here.')), btn('Open Providers', () => show('engine'), 'primary')));
  }
  const roles = h('div', { class: 'roles' });
  replace(el, roles);
  renderModelRoles(roles, engine);
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
  } }, themePreview(v), h('span', { class: 'theme-n' }, h('span', null, l), icon('check', 13, 'theme-ok')))));
  const val = h('span', { class: 'num range-v' }, `${u.fontSize || 14}px`);
  const size = h('input', { type: 'range', min: 12, max: 18, step: 1, value: u.fontSize || 14, 'aria-label': 'Message text size', oninput: () => ((val.textContent = size.value + 'px'), savePrefs({ fontSize: +size.value })) });
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Theme'), themes),
    group('Reading', null,
      row('Message text size', h('div', { class: 'row' }, size, val)),
      h('p', { class: 'fs-sample' }, 'The quick brown fox: this is how replies will read.'),
      row('Show model thinking', toggle(u.showThinking !== false, (v) => savePrefs({ showThinking: v }), 'Show model thinking'), 'Shows the model’s reasoning above its reply, folded until you open it.')),
    group('Layout', null,
      window.orbixDesktop ? row('Interface size', scaleSelect(u), 'Scales everything in the window. Auto picks a size for your screen and goes larger on wide, high-resolution screens.') : null,
      row('Density', seg('Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], u.density === 'compact' ? 'compact' : 'comfortable', (v) => savePrefs({ density: v })), 'Compact fits more rows in the sidebar and more steps on the screen.'),
      row('Reading column', seg('Reading column', [['normal', 'Normal'], ['wide', 'Wide']], document.documentElement.classList.contains('wide') ? 'wide' : 'normal', (v) => (v === 'wide') !== document.documentElement.classList.contains('wide') && toggleWide()), 'Wide suits long diffs and tables. The session bar has the same switch.')));
}

/** Interface size in the Windows app: Auto, or a fixed scale. */
function scaleSelect(u) {
  const cur = typeof u.uiScale === 'number' ? String(u.uiScale) : 'auto';
  const opts = [['auto', 'Auto'], ['0.9', '90%'], ['1', '100%'], ['1.1', '110%'], ['1.25', '125%'], ['1.5', '150%']];
  return h('select', { class: 'scale-sel', 'aria-label': 'Interface size', onchange: (e) => savePrefs({ uiScale: e.target.value === 'auto' ? 'auto' : Number(e.target.value) }) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
}

/** A small drawing of the app in a theme: sidebar, a reply, your message and the message box. System shows dark and light side by side. */
function themePreview(v) {
  const win = (t) => h('span', { class: `tp-win tp-${t}` },
    h('span', { class: 'tp-side' }, h('b', { class: 'tp-brand' }), h('b', { class: 'tp-row cur' }), h('b', { class: 'tp-row' }), h('b', { class: 'tp-row short' })),
    h('span', { class: 'tp-sheet' },
      h('b', { class: 'tp-you' }),
      h('b', { class: 'tp-line' }), h('b', { class: 'tp-line mid' }), h('b', { class: 'tp-line short' }),
      h('span', { class: 'tp-box' }, h('b', { class: 'tp-ph' }), h('b', { class: 'tp-send' }))));
  return h('span', { class: `theme-p ${v}`, 'aria-hidden': 'true' }, ...(v === 'system' ? [win('dark'), win('light')] : [win(v)]));
}

/** A row of two or three choices, one selected. */
function seg(label, options, value, onPick) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [v, l] of options) {
    wrap.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: (e) => {
      for (const x of wrap.children) x.setAttribute('aria-checked', String(x === e.currentTarget));
      onPick(v);
    } }, l));
  }
  return wrap;
}

// ================= shortcuts =================

function tabKeys(el) {
  const q = h('input', { type: 'search', class: 'keys-q', placeholder: 'Filter shortcuts', 'aria-label': 'Filter shortcuts', spellcheck: 'false', autocomplete: 'off' });
  const list = h('dl', { class: 'keys keys-page' });
  const none = h('p', { class: 'set-none', hidden: true }, 'No shortcut matches.');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const hits = SHORTCUTS.filter(([k, d]) => !t || `${k} ${d}`.toLowerCase().includes(t));
    replace(list, hits.map(([k, d]) => [h('dt', null, keyCaps(k)), h('dd', null, d)]));
    none.hidden = !!hits.length;
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => e.key === 'Escape' && q.value && (e.stopPropagation(), e.preventDefault(), (q.value = ''), draw()));
  draw();
  el.append(q, h('div', { class: 'set-card keys-card' }, list, none));
  setTimeout(() => q.focus({ preventScroll: true }), 0);
}

// ================= permissions =================

function tabBehavior(el) {
  const mode = S.engine?.approvals || 'ask';
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
  const choice = (value, ic, title, text, tag) => h('button', { class: `perm is-${value}`, type: 'button', role: 'radio', 'aria-checked': String(mode === value), onclick: (e) => e.currentTarget.getAttribute('aria-checked') !== 'true' && set(value, e.currentTarget) },
    h('span', { class: 'perm-ic' }, icon(ic, 16)),
    h('span', { class: 'perm-m' }, h('span', { class: 'perm-h' }, h('span', { class: 'perm-t' }, title), tag ? h('span', { class: 'tag' }, tag) : null), h('span', { class: 'perm-d' }, text)),
    h('span', { class: 'perm-r', 'aria-hidden': 'true' }));
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'File edits and commands'), h('p', { class: 'set-note' }, 'Reading and searching never ask.'),
      h('div', { class: 'perms', role: 'radiogroup', 'aria-label': 'File edits and commands' },
        choice('ask', 'shield', 'Ask me first', 'Each file edit and command waits for your OK.', 'Recommended'),
        choice('edits', 'pencil', 'Allow edits, ask before commands', 'File edits run without asking, and each one can be undone. Commands still wait for your OK.'),
        choice('auto', 'bolt', 'Allow everything', 'File edits and commands run without asking. Edits can be undone; commands cannot.'))),
    trustedGroup(),
    group('Running', null, whereRow(), row('Follow new output', toggle(S.ui.autoScroll !== false, (v) => savePrefs({ autoScroll: v }), 'Follow new output'), 'Scrolls to the newest text while a reply streams in, unless you have scrolled up.')));
}

/**
 * Commands that run without asking. Added from an approval ("Always allow this command") or here. "npm run *" also
 * covers "npm run build". A command that chains, pipes or redirects (&&, ;, |, >) never matches, whatever is listed.
 */
function trustedGroup() {
  const list = h('div', { class: 'trust-list' });
  const input = h('input', { type: 'text', class: 'trust-in', placeholder: 'npm test, or npm run * for any script', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Command to trust' });
  const save = async (next, done) => {
    try {
      await api.post('/api/engine/settings', { trusted: next });
      await loadEngine();
      draw();
      done?.();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const add = () => {
    const c = input.value.trim().replace(/\s+/g, ' ');
    if (!c) return input.focus();
    if (/[;&|`<>]|\$\(/.test(c)) return toast('A trusted command cannot chain, pipe or redirect (; & | < >).', 'error', 5000);
    save([...(S.engine?.trusted || []), c], () => { input.value = ''; input.focus(); });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
  function draw() {
    const items = S.engine?.trusted || [];
    replace(list, items.length
      ? items.map((c) => h('div', { class: 'trust-row' }, h('code', { class: 'ell', title: c }, c), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Stop trusting ${c}`, onclick: () => save(items.filter((x) => x !== c)) }, 'Remove')))
      : h('p', { class: 'set-none' }, 'None yet. When a command asks for approval, choose Always allow this command, or add one below.'));
  }
  draw();
  return h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Trusted commands'),
    h('p', { class: 'set-note' }, 'These commands run without asking, in every mode. End one with * to allow any arguments. A command that chains, pipes or redirects always asks.'),
    h('div', { class: 'set-card trust-card' }, list, h('div', { class: 'trust-add' }, input, btn('Trust', add, 'sm'))));
}

// ================= checks =================

function tabChecks(el) {
  const eng = S.engine || {};
  const save = async (body) => {
    try {
      await api.post('/api/engine/settings', body);
      await loadEngine();
      toast('Saved', 'ok', 1200);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  el.append(
    group('After the agent changes files', 'The check runs when the agent says it is done. If the check fails, the agent gets its output and fixes the cause before it replies.',
      row('Run the project’s check', seg('Run the project’s check', [['off', 'Off'], ['ask', 'Ask'], ['always', 'Always']], eng.verify || 'ask', (v) => save({ verify: v })), 'Off never runs it. Ask lets you choose each time. Always runs it like any other command, so it still waits for your OK unless the command is trusted.'),
      row('Review the changes', toggle(eng.review !== false, (v) => save({ review: v }), 'Review the changes'), 'Before the reply, the fast model (or the session’s model) reads the changes once and reports real defects for the agent to fix. It is skipped when fewer than 5 lines changed.')),
    checkCommandGroup(activeTab()?.workspace || homeProject()));
}

/** The check command of the open project: the one found in its files, or one you set (or none). */
function checkCommandGroup(ws) {
  const head = h('h4', { class: 'set-sub' }, 'Check command');
  if (!ws) return h('section', { class: 'set-group' }, head, h('p', { class: 'set-note' }, 'Open a project to see or change its check command.'));
  const input = h('input', { type: 'text', class: 'trust-in', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Check command for this project' });
  const found = h('p', { class: 'set-none' }, 'Looking at the project…');
  const show = (j) => {
    input.value = j.command && j.command !== 'off' ? j.command : '';
    input.placeholder = j.detected?.command || 'npm test';
    const d = j.detected ? `${j.detected.command}, from ${j.detected.source}` : '';
    found.textContent = j.command === 'off' ? 'No check runs in this project.' : j.command ? `Your command runs${d ? ` instead of ${d}` : ''}.` : d ? `Found ${d}.` : 'Nothing was found: there is no test, typecheck, lint or build script, Cargo.toml, go.mod, pytest setup or Makefile target. Type a command to use one.';
  };
  const save = async (command) => {
    try {
      show(await api.post('/api/engine/check', { ws, command }));
      toast('Saved', 'ok', 1200);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  api.get(`/api/engine/check?ws=${encodeURIComponent(ws)}`).then(show).catch((e) => (found.textContent = e.message));
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), save(input.value)));
  return h('section', { class: 'set-group' }, head,
    h('p', { class: 'set-note' }, 'For ', h('bdi', null, ws), '. Leave the box empty to use the command found in the project.'),
    h('div', { class: 'set-card trust-card' }, found, h('div', { class: 'trust-add' }, input, btn('Save', () => save(input.value), 'sm'), btn('No check in this project', () => save('off'), 'sm ghost'))));
}

// ================= instructions =================

function tabRules(el) {
  const ta = h('textarea', { class: 'rules-ta', rows: 14, spellcheck: 'true', 'aria-label': 'Instructions for every project', placeholder: 'For example:\n- Answer briefly; show the change, then how you checked it.\n- Use pnpm, never npm.\n- Run the tests before saying something works.\n- Never commit unless I ask.' });
  const count = h('span', { class: 'rules-n num' });
  const saveBtn = btn('Save', () => save(), 'primary sm');
  const status = h('span', { class: 'rules-status', role: 'status' });
  let saved = '';
  const sync = () => {
    count.textContent = `${ta.value.length.toLocaleString()} / 24,000`;
    count.classList.toggle('over', ta.value.length > 24000);
    saveBtn.disabled = ta.value === saved || ta.value.length > 24000;
  };
  async function save() {
    try {
      const r = await api.post('/api/instructions', { text: ta.value });
      saved = ta.value = r.text;
      status.textContent = r.text ? 'Saved. New messages in every session follow these instructions.' : 'Cleared.';
      sync();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  ta.addEventListener('input', () => { status.textContent = ''; sync(); });
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!saveBtn.disabled) save(); } });
  const failed = h('div', { class: 'rules-err' });
  el.append(
    h('section', { class: 'set-group' },
      h('p', { class: 'set-note' }, 'Write plain text or Markdown. A project’s own AGENTS.md or CLAUDE.md comes after this and wins when the two disagree.'),
      failed,
      ta,
      h('div', { class: 'rules-foot' }, count, h('span', { class: 'grow' }), status, saveBtn)));
  sync();
  // Nothing can be typed until the saved text is in, so an early keystroke never overwrites it.
  function load() {
    ta.disabled = true;
    replace(failed);
    status.textContent = 'Loading…';
    return api.get('/api/instructions').then((r) => {
      saved = ta.value = r.text || '';
      ta.disabled = false;
      status.textContent = '';
      sync();
      ta.focus({ preventScroll: true });
    }).catch((e) => {
      status.textContent = '';
      replace(failed, errorState(e.message, { title: 'Couldn’t load your instructions.', retry: load }));
    });
  }
  load();
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
  return row('Run commands in', sel, 'In WSL, Windows drives appear as /mnt/c, /mnt/d and so on.');
}

// ================= about =================

const COMX_URL = 'https://comx-site.vercel.app';
const ISSUES_URL = 'https://github.com/chsxthwik/ORBIX/issues';
const openLink = (url) => api.post('/api/open-url', { url }).catch((e) => toast(e.message, 'error'));

const RELEASES_URL = 'https://github.com/chsxthwik/ORBIX/releases';

/** Settings → About → Updates, in the Windows app. It redraws itself as the status changes. */
function updatesGroup() {
  if (!updatesSupported()) return ''; // el.append() would print null
  const box = h('div');
  let drawn = false;
  const draw = () => {
    if (drawn && !box.isConnected) return off(); // the settings sheet was closed
    drawn = true;
    const st = S.update;
    const busy = st.state === 'checking' || st.state === 'downloading';
    const action = st.state === 'ready'
      ? btn('Restart to update', () => restartToUpdate(), 'sm primary')
      : h('button', { class: 'btn sm', type: 'button', disabled: busy ? true : null, onclick: () => checkForUpdates() }, st.state === 'checking' ? 'Checking…' : st.state === 'downloading' ? `${st.percent || 0}%` : 'Check now');
    replace(box, group('Updates', null,
      row(st.state === 'ready' ? `ORBIX ${st.version} is ready` : `ORBIX ${st.current}`, action, h('span', { class: 'upd-line' + (st.state === 'error' ? ' err' : '') }, updateLine(st))),
      row('Update automatically', toggle(st.auto, (v) => setAutoUpdates(v), 'Update automatically'), 'Downloads new versions in the background from GitHub. Each download is checked before it installs, and your settings and conversations are kept.'),
      row('What’s new', btn('Release notes', () => openLink(RELEASES_URL), 'sm'), 'Every version and what changed in it.')));
  };
  const off = on('update', draw);
  draw();
  return box;
}

function tabAbout(el, show) {
  const b = S.env.backend;
  el.append(
    h('div', { class: 'about-h' }, logo(38), h('div', null,
      h('div', { class: 'about-name' }, h('strong', null, 'ORBIX'), h('span', { class: 'tag on', title: 'Features and screens may still change between versions.' }, 'Beta')),
      h('p', null, `Version ${S.env.app.version}`))),
    h('p', { class: 'about-lead' }, 'A coding agent that works inside your projects, on your own computer. It reads freely, asks before it edits a file or runs a command, and lets you undo every edit.'),
    h('section', { class: 'about-maker', 'aria-label': 'Made by COM-X Corporation' },
      asciiComx().el,
      h('div', { class: 'about-maker-t' },
        h('span', { class: 'about-by' }, 'Developed by'),
        h('strong', null, 'COM-X Corporation'),
        h('p', null, 'Company X finds the problems that matter most and builds their solutions. ORBIX is its coding workspace.'),
        h('button', { class: 'link', type: 'button', title: COMX_URL, onclick: () => openLink(COMX_URL) }, 'Visit COM-X', icon('external', 12)))),
    updatesGroup(),
    group(null, null,
      row('Report a problem', btn('Open GitHub', () => openLink(ISSUES_URL), 'sm'), 'Report a bug or suggest a feature on GitHub.'),
      row('Commands run in', b.kind === 'wsl' ? `WSL (${b.distro})` : 'Windows'),
      row('How ORBIX works', btn('Open', () => openHelp(), 'sm'), 'A short guide to connecting a model, approvals, undo and project rules.'),
      row('Keyboard shortcuts', btn('Show', () => show('keys'), 'sm'), 'Every shortcut, with a filter.'),
      row('Quit ORBIX', btn('Quit', async () => {
        if (await confirmDialog('Quit ORBIX', 'Stop all sessions and close ORBIX?', { ok: 'Quit', danger: true })) {
          await api.post('/api/quit').catch(() => {});
        }
      }, 'sm danger'), 'Stops every running session.')));
}
