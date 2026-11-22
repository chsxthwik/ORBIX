// Settings: the whole window under the menu row. Pages on the left (General to Machines, Agent, one page per
// project, conversations and worktrees), Give feedback and this copy of ORBIX at the bottom. Esc or × closes it.
// Ctrl+K finds any setting by name (settingsSearchItems) and opens its page.
import { tabAnalytics } from './analytics.js';
import { h, icon, toast, replace, clear, logoTile, errorState, loadingState, copyText, timeAgo, baseName, kbd, onEnter } from './dom.js';
import { api } from './api.js';
import { S, on, savePrefs, engineReady, loadEngine, loadEnv, loadSessions, emit, groupSessions, activeTab } from './store.js';
import { colWidth, setColWidth } from './workbench.js';
import { modal, btn, confirmDialog, row, toggle, folderPicker } from './dialogs.js';
import { notifyPrefs, attention, notifyPermission, askNotifyPermission, chime } from './notify.js';
import { allRuns } from './runs.js';
import { renderEngineSettings, openLink } from './engine.js';
import { renderModelRoles } from './models.js';
import { renderMcpSettings } from './mcp.js';
import { openHelp } from './help.js';
import { openDiagnostics } from './diagnostics.js';
import { asciiComx } from './ascii.js';
import { homeProject } from './home.js';
import { previewCelebration } from './backdrop.js';
import { updatesSupported, checkForUpdates, setAutoUpdates, restartToUpdate, updateLine } from './updates.js';
import { ACTIONS, FIXED, comboOf, comboParts, comboProblem, effectiveKeys, assignCombo, removeCombo, resetKeys } from './keys.mjs';
import { browserPrefs, clearBrowserHistory, desktopBrowser } from './browser.js';
import { modelRatings, clearRatings } from './ratings.js';
import { tabAgents } from './agents.js';
import { tabMachines } from './machines.js';
import { lookExtraGroups, generalExtraGroups, browserExtraGroups, keepAwakeMode, agentOptionGroups } from './prefs-extra.js';
import { group, pick, seg } from './settings-controls.js';

/** The pages in the list, in groups: [key, label, one line under the title, icon]. */
const NAV = [
  [
    ['general', 'Preferences', 'Permissions and how messages are sent.', 'sliders'],
    ['look', 'Appearance', 'Theme, text and layout.', 'palette'],
    ['notify', 'Notifications', 'When ORBIX gets your attention.', 'bell'],
    ['keys', 'Shortcuts', 'Keys need Ctrl or Alt, or are a function key.', 'keyboard'],
  ],
  [
    ['engine', 'Providers', 'Sign in, add an API key or use a local server. Keys are stored encrypted.', 'plug'],
    ['models', 'Models', 'Which model does which job.', 'sparkle'],
    ['agents', 'Agents', 'Claude Code, Codex, OpenCode and other agent CLIs, on their own plans.', 'cpu'],
    ['tools', 'Tools & MCP', 'Built-in tools, web search and hooks. Manage MCP servers in Plugins.', 'puzzle'],
    ['rules', 'Instructions', 'What the agent follows in every project.', 'pencil'],
    ['checks', 'Checks', 'What the agent runs before it says it is done.', 'check'],
  ],
  [
    ['projects', 'Projects', 'Every folder ORBIX knows.', 'folder'],
    ['worktrees', 'Worktrees', 'Branches that runs and conversations use, apart from your checkout.', 'git-fork'],
    ['conversations', 'Conversations', 'Archived, and deleted in the last 30 days.', 'archive'],
    ['machines', 'Machines', 'Your own computers running ORBIX, so work goes on while this PC sleeps.', 'server'],
    ['browser', 'Browser', 'Links, the built-in browser, history and downloads.', 'globe'],
  ],
  [
    ['usage', 'Analytics', 'Tokens, models and when you work, from the conversations on this PC.', 'activity'],
    ['feedback', 'Help & feedback', 'Opens a GitHub issue in your browser. You check it before it is sent.', 'message'],
    ['application', 'About', 'Updates, data folder and version.', 'info'],
  ],
];
/** Pages reached from another page, with the page they belong to. */
const SUB = [
  ['behavior', 'Tool permissions', 'What runs without asking, and where commands run.', null, 'general'],
  ['network', 'Network access rules', 'Which sites the agent may read with web_fetch.', null, 'general'],
];
const PAGES = [...NAV.flat(), ...SUB];
const OLD = { start: 'general', prefs: 'general', about: 'application' }; // page names from before 3.7

/** What Ctrl+K finds: [setting, page, extra words]. */
const FIND = [
  ['API keys', 'engine', 'provider key anthropic openai gemini openrouter connect sign in'],
  ['Local models', 'engine', 'ollama lm studio offline server custom'],
  ['Machines', 'machines', 'cloud vps server remote teleport move self-host linux tailscale'],
  ['Agents', 'agents', 'claude code codex opencode gemini acp harness cli agent subscription plan'],
  ['Your name', 'general', 'name greeting home display'],
  ['Analytics', 'usage', 'tokens usage stats statistics models prompts hours streak heatmap chart cost'],
  ['Fast model', 'models', 'titles summaries helper agents cheap'],
  ['Plan model', 'models', 'plan mode'],
  ['Permission preset', 'general', 'approval ask allow permission auto edits turbo'],
  ['Trusted commands', 'behavior', 'allow always command npm test run trust tool permissions'],
  ['Network access rules', 'network', 'web fetch sites allow deny block url domain'],
  ['While the agent works', 'general', 'queue steer queued messages send immediately'],
  ['Send messages with', 'general', 'enter ctrl newline send key keyboard'],
  ['Follow new output', 'general', 'scroll auto'],
  ['Run the project’s check', 'checks', 'verify test tests lint build typecheck after edits'],
  ['Review the changes', 'checks', 'review diff self-review defects bugs'],
  ['Instructions for every project', 'rules', 'agents.md rules memory preferences custom prompt'],
  ['Run commands in', 'behavior', 'shell wsl windows powershell kali windows subsystem for linux distribution distro'],
  ['Sort projects', 'look', 'sidebar order name recent'],
  ['Show archived conversations', 'look', 'archive hide sidebar'],
  ['Archived', 'conversations', 'archive unarchive'],
  ['Recently deleted', 'conversations', 'trash restore deleted empty'],
  ['When the agent finishes', 'notify', 'notification done finished alert'],
  ['When the agent needs you', 'notify', 'notification approval question input'],
  ['Volume', 'notify', 'sound chime audio beep loud'],
  ['Flash the taskbar', 'notify', 'taskbar flash attention'],
  ['Open links in', 'browser', 'built-in browser external links'],
  ['Download location', 'browser', 'downloads folder save'],
  ['Browsing history', 'browser', 'history clear autocomplete'],
  ['Worktrees', 'worktrees', 'branch worktree runs git'],
  ['Web search', 'tools', 'brave tavily searxng'],
  ['MCP servers', 'tools', 'server tools mcp'],
  ['Hooks', 'tools', 'before after tool'],
  ['Theme', 'look', 'dark light system midnight frost graphite monochrome palette tokyo night catppuccin mocha latte rose pine dawn nord dracula gruvbox orbix scene synthwave nebula aurora animated backdrop fireworks color'],
  ['Font size', 'look', 'text size zoom bigger smaller'],
  ['Font', 'look', 'typeface google sans segoe system'],
  ['Contrast', 'look', 'strong high contrast'],
  ['Theme colors', 'look','background foreground accent colour color custom'],
  ['Animate scenes', 'look', 'animation motion backdrop'],
  ['Conversation steps', 'look', 'verbose fold steps worked for'],
  ['Screen reader mode', 'look', 'accessibility a11y motion narrator'],
  ['Interface size', 'look', 'scale zoom ui size'],
  ['Density', 'look', 'compact comfortable spacing rows'],
  ['Conversation width', 'look', 'reading column wide narrow fill width'],
  ['Your ratings', 'models', 'thumbs up down rating feedback model'],
  ['Show model thinking', 'look', 'reasoning'],
  ['Keyboard shortcuts', 'keys', 'keys hotkeys keybindings rebind'],
  ['Updates', 'application', 'update upgrade new version check download install release'],
  ['Data folder', 'application', 'logs folder settings location'],
  ['Keep awake', 'application', 'awake sleep power prevent screen display caffeine'],
  ['Keep running in the tray', 'application', 'tray background close minimize'],
  ['Notification settings', 'notify', 'windows do not disturb banners focus'],
  ['Help & feedback', 'feedback', 'give feedback bug report feature request issue problem'],
  ['Code font', 'look', 'monospace typeface cascadia consolas geist code blocks diffs'],
  ['Code font size', 'look', 'monospace code blocks diffs file previews text size'],
  ['Word wrap', 'look', 'long lines wrap code blocks file previews scroll sideways'],
  ['Diff colors', 'look', 'red green blue orange colorblind colour blindness additions deletions'],
  ['Animations', 'look', 'motion panel animations reduce motion transitions off'],
  ['Time format', 'general', 'timestamp clock 12 hour 24 hour relative ago'],
  ['Ask before deleting a conversation', 'general', 'delete confirmation confirm ask'],
  ['Ask before closing a working conversation', 'general', 'close stop confirmation confirm ask'],
  ['Search engine', 'browser', 'address bar duckduckgo google bing brave kagi ecosia custom url search'],
];

/** Ctrl+K: every setting, as search items that open its page. */
export function settingsSearchItems() {
  return FIND.map(([label, page, words]) => ({ group: 'Settings', scope: 'commands', searchOnly: true, icon: 'cog', label, hint: PAGES.find(([k]) => k === page)?.[1], text: words, run: () => openSettings(page, label) }));
}

/** A row that opens another page or view: the whole row is the button, with a chevron. */
const go = (label, hint, onclick) => h('button', { class: 'set-row set-go', type: 'button', onclick },
  h('div', { class: 'set-k' }, h('div', { class: 'set-l' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null),
  icon('chevron-right', 14));

/** "3 trusted commands" / "No trusted commands". */
const trustedLine = (n) => `${n || 'No'} trusted command${n === 1 ? '' : 's'}`;

/** The projects, most recent first. */
const projectList = () => groupSessions().filter((g) => g.path).sort((a, b) => (b.latest || 0) - (a.latest || 0));

let current = null; // the open settings card, so a second open only changes its page

/** Open Settings on a page (general, look, keys, engine, …, or proj:<path>). `focus` points at one setting on it. */
// A menu-row action taken while Settings fills the window closes it first, so what it does is not hidden behind it.
on('settings:close', () => current?.close());

export function openSettings(initial = 'general', focus = '') {
  initial = OLD[initial] || initial;
  if (current?.isOpen()) return current.show(initial, focus);
  const valid = (k) => PAGES.some(([p]) => p === k) || k.startsWith('proj:');
  let cur = valid(initial) ? initial : 'general';
  const list = h('div', { class: 'set-pages', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings pages' });
  const back = h('button', { class: 'set-back', type: 'button', title: 'Back to the app (Esc)', onclick: () => m.close() }, icon('arrow-left', 14), h('span', { class: 'grow' }, 'Back to app'), h('kbd', { class: 'set-kbd' }, 'Esc'));
  const search = h('input', { type: 'search', class: 'set-search-in', placeholder: 'Search', 'aria-label': 'Search settings', spellcheck: 'false', autocomplete: 'off' });
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings' }, back, h('label', { class: 'set-search' }, icon('search', 14), search, h('kbd', { class: 'set-kbd' }, '/')), list);
  const content = h('div', { class: 'set-content', role: 'tabpanel', tabindex: '-1' });
  const wrap = h('div', { class: 'set-wrap' }, nav, h('div', { class: 'set-main' }, content));
  // "/" anywhere in Settings outside a text field jumps to the search, as the hint beside it says.
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    search.focus();
    search.select();
  });
  let disposePage;
  let offSessions;
  const m = modal({ title: 'Settings', cls: 'settings settings-card', body: wrap, onClose: () => {
    disposePage?.();
    offSessions?.();
    current = null;
  } });

  // A project's own page belongs to Projects; a sub-page to its parent.
  const navKey = (k) => (k.startsWith('proj:') ? 'projects' : PAGES.find(([p]) => p === k)?.[4] || k);
  const tab = ([key, label, , ic]) => {
    const on = navKey(cur) === key && !search.value.trim();
    return h('button', { type: 'button', role: 'tab', id: `set-${key}`, 'aria-selected': String(on), tabindex: on ? '0' : '-1', class: 'set-tab' + (on ? ' cur' : ''), onclick: () => show(key) },
      icon(ic, 15), h('span', { class: 'ell grow' }, label),
      key === 'engine' && !(S.engine?.providers || []).some((p) => p.configured) ? h('span', { class: 'dot warn', title: 'No model connected' }) : null);
  };
  const drawNav = () => replace(list, NAV.map((g) => h('div', { class: 'set-nav-g' }, g.map(tab))));

  const head = (title, lead, crumb) => h('header', { class: 'set-head' },
    crumb ? h('button', { class: 'set-crumb', type: 'button', onclick: () => show(crumb[0]) }, icon('arrow-left', 13), crumb[1]) : null,
    h('div', { class: 'set-head-row' }, h('h3', { class: 'set-title' }, title)),
    lead ? h('p', { class: 'set-lead' }, lead) : null);

  const show = (name, focusLabel = '', focusNav = false) => {
    name = OLD[name] || name;
    if (!valid(name)) name = 'general';
    cur = name;
    if (search.value) search.value = '';
    drawNav();
    nav.querySelector('.set-tab.cur')?.scrollIntoView({ block: 'nearest' });
    content.setAttribute('aria-labelledby', `set-${navKey(name)}`);
    disposePage?.();
    disposePage = null;
    clear(content);
    wrap.scrollTop = 0;
    const body = h('div', { class: 'set-body' });
    if (name.startsWith('proj:')) {
      const p = name.slice(5);
      const g = projectList().find((x) => x.path === p);
      content.append(head(g?.name || baseName(p), h('bdi', null, p), ['projects', 'Projects']), body);
      tabProject(body, show, m, p);
    } else {
      const page = PAGES.find(([k]) => k === name);
      const parent = page[4] && PAGES.find(([k]) => k === page[4]);
      content.append(head(page[1], page[2], parent), body);
      const cleanup = ({ usage: tabAnalytics, general: tabGeneral, application: tabApplication, look: tabLook, keys: tabKeys, notify: tabNotify, engine: renderEngineSettings, agents: (b, s, mm) => { const r = tabAgents(b, s, mm); b.append(...agentOptionGroups()); return r; }, machines: tabMachines, models: tabModels, browser: tabBrowser, rules: tabRules, checks: tabChecks, tools: renderMcpSettings, conversations: tabConversations, worktrees: tabWorktrees, behavior: tabBehavior, network: tabNetwork, projects: tabProjects, feedback: tabFeedback })[name](body, show, m);
      if (typeof cleanup === 'function') disposePage = cleanup;
    }
    if (focusLabel) pointAt(content, focusLabel);
    if (focusNav) nav.querySelector('.set-tab.cur')?.focus();
  };

  // Search: every setting by name and by the words around it; a result opens its page at that setting.
  const results = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return show(cur);
    drawNav();
    disposePage?.();
    disposePage = null;
    clear(content);
    wrap.scrollTop = 0;
    const words = q.split(/\s+/);
    const hits = FIND.filter(([label, page, extra]) => {
      const text = `${label} ${PAGES.find(([k]) => k === page)?.[1] || ''} ${extra}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const pageHits = PAGES.filter(([k, label]) => label.toLowerCase().includes(q) && !hits.some(([, p]) => p === k));
    const item = (label, page, focus) => h('button', { class: 'set-row set-hit', type: 'button', onclick: () => show(page, focus) },
      h('div', { class: 'set-k' }, h('div', { class: 'set-l' }, label), h('div', { class: 'set-hint' }, PAGES.find(([k]) => k === page)?.[1])), icon('chevron-right', 14));
    content.append(head('Search', null),
      hits.length || pageHits.length
        ? h('div', { class: 'set-card' }, ...pageHits.map(([k, label]) => item(label, k, '')), ...hits.map(([label, page]) => item(label, page, label)))
        : h('p', { class: 'set-none' }, `No setting matches “${search.value.trim()}”.`));
  };
  search.addEventListener('input', results);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) (e.preventDefault(), e.stopPropagation(), (search.value = ''), show(cur));
    if (e.key === 'Enter') content.querySelector('.set-hit')?.click();
  });

  // ↑ / ↓ move through the pages, Home / End to the first and last.
  nav.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !e.target.closest('.set-tab')) return;
    e.preventDefault();
    const tabs = [...nav.querySelectorAll('.set-tab')];
    const i = tabs.indexOf(e.target.closest('.set-tab'));
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    nav.querySelector('.set-tab.cur')?.focus();
  });
  offSessions = on('sessions', () => !search.value.trim() && drawNav());
  show(cur, focus);
  setTimeout(() => nav.querySelector('.set-tab.cur')?.focus({ preventScroll: true }), 0);
  current = { isOpen: () => content.isConnected, show: (k, f) => show(OLD[k] || k, f), close: () => m.close() };
  return m;
}

/** Scroll to a setting by its label and mark it for a moment (some pages draw their rows after a load). */
function pointAt(content, label) {
  const t0 = Date.now();
  const seek = () => {
    const el = [...content.querySelectorAll('.set-l, .set-sub, .perm-t')].find((x) => x.textContent === label);
    if (el) {
      const box = el.closest('.set-row, .set-group, .perm') || el;
      box.scrollIntoView({ block: 'center' });
      box.classList.add('set-flash');
    } else if (Date.now() - t0 < 1500) requestAnimationFrame(seek);
  };
  requestAnimationFrame(seek);
}

/** "just now", "5m ago", "on Nov 3". */
const ago = (ts) => {
  const t = timeAgo(ts);
  return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
};

// Settings save as you change them; the control itself shows the new value, so only a failure says anything.
const saveEngine = async (body) => {
  try {
    await api.post('/api/engine/settings', body);
    await loadEngine();
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
};

// ================= general =================

/** Permission presets: [value, name, what it does, icon]. One list for Preferences and Tool permissions. */
const MODES = [
  ['ask', 'Supervised', 'Every file edit and command waits for your OK.', 'lock'],
  ['edits', 'Auto edits', 'Edits run without asking and can be undone. Commands wait for your OK.', 'pencil'],
  ['safe', 'Guarded', 'Edits and read-only commands (ls, cat, grep, git status, diff, log) run without asking. Other commands wait.', 'shield-check'],
  ['auto', 'Full access', 'Edits and commands run without asking, also outside the project. Commands cannot be undone; destructive ones still ask.', 'shield-off'],
];

/** Ask before Full access; returns whether to go on. */
const confirmFull = () => confirmDialog('Give full access', 'The agent will edit files and run commands without asking, also outside the project folder. Every file edit can still be undone, but commands cannot. Destructive commands (deleting folders, pushing, publishing) still ask.', { ok: 'Give full access', danger: true });

function tabGeneral(el, show) {
  const u = S.ui;
  const eng = S.engine || {};
  const mode = eng.approvals || 'ask';
  const modeHint = h('span', null, MODES.find(([k]) => k === mode)?.[2]);
  const preset = pick('Permission preset', MODES.map(([k, l]) => [k, l]), mode, async (v, sel) => {
    if (v === 'auto' && !(await confirmFull())) return (sel.value = S.engine?.approvals || 'ask');
    if (await saveEngine({ approvals: v })) modeHint.textContent = MODES.find(([k]) => k === v)?.[2];
    else sel.value = S.engine?.approvals || 'ask';
  });
  const net = eng.network || { allow: [], deny: [] };
  const netLine = net.allow.length ? `${net.allow.length} allowed site${net.allow.length === 1 ? '' : 's'}, every other site asks${net.deny.length ? `, ${net.deny.length} denied` : ''}` : net.deny.length ? `Any site except ${net.deny.length} denied` : 'Any site. Local addresses ask first';
  const where = S.env.backend.kind === 'wsl' ? `WSL${S.env.backend.distro ? ` (${S.env.backend.distro})` : ''}` : 'Windows';
  el.append(
    engineReady() ? '' : h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'Connect a model to start'), h('p', null, 'A sign-in, an API key or a model on this PC.')), btn('Connect a model', () => show('engine'), 'primary')),
    group('Permissions', null,
      row('Permission preset', preset, modeHint),
      go('Tool permissions', `${trustedLine((eng.trusted || []).length)} · Commands run in ${where}`, () => show('behavior')),
      go('Network access rules', netLine, () => show('network'))),
    group('Messages', null,
      row('While the agent works', seg('While the agent works', [['steer', 'Steer'], ['queue', 'Queue']], u.whileBusy === 'queue' ? 'queue' : 'steer', (v) => savePrefs({ whileBusy: v })), 'Steer: read at the agent’s next step. Queue: sent when the turn ends. Alt+Enter does the other.'),
      row('Send messages with', seg('Send messages with', [['enter', 'Enter'], ['ctrl', 'Ctrl+Enter']], u.sendKey === 'ctrl' ? 'ctrl' : 'enter', (v) => savePrefs({ sendKey: v })), 'The other key adds a new line.'),
      row('Follow new output', toggle(u.autoScroll !== false, (v) => savePrefs({ autoScroll: v }), 'Follow new output'), 'Keep a streaming reply in view, unless you scroll up.')),
    group('You', null,
      row('Your name', (() => {
        const input = h('input', { type: 'text', class: 'set-name', value: u.displayName || '', placeholder: 'Not set', maxlength: 40, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Your name' });
        let t = null;
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => savePrefs({ displayName: input.value.trim() }), 400);
        });
        return input;
      })(), 'Shown in the greeting on Home.')),
    ...generalExtraGroups());
}

// ================= network rules =================

function tabNetwork(el) {
  const editor = (key, title, note, placeholder) => {
    const listEl = h('div', { class: 'trust-list' });
    const input = h('input', { type: 'text', class: 'trust-in', placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': `Add to ${title.toLowerCase()}` });
    const items = () => (S.engine?.network || { allow: [], deny: [] })[key] || [];
    const save = async (next) => {
      if (await saveEngine({ network: { [key]: next } })) draw();
    };
    const add = async () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      const before = items().length;
      await save([...items(), v]);
      if (items().length === before) toast('That is not a site: use a name like example.com, *.example.com or example.com/docs.', 'error', 4500);
      else (input.value = ''), input.focus();
    };
    onEnter(input, add);
    function draw() {
      const list = items();
      replace(listEl, list.length ? list.map((r) => h('div', { class: 'trust-row' }, h('code', { class: 'ell', title: r }, r), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Remove ${r}`, onclick: () => save(list.filter((x) => x !== r)) }, 'Remove'))) : h('p', { class: 'set-none' }, key === 'allow' ? 'None. Every site that is not denied is read without asking.' : 'None.'));
    }
    draw();
    return h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, title), h('p', { class: 'set-note' }, note), h('div', { class: 'set-card trust-card' }, listEl, h('div', { class: 'trust-add' }, input, btn('Add', add, 'sm'))));
  };
  el.append(
    editor('allow', 'Allowed sites', 'Read without asking. Once this list has a site, every other site asks first. example.com covers its subdomains, *.example.com only the subdomains, example.com/docs only that path.', 'example.com, *.example.com or example.com/docs'),
    editor('deny', 'Denied sites', 'Never read, even through a redirect. Denied wins over allowed. * denies every site.', 'example.com'),
    h('p', { class: 'set-note set-after-note' }, 'Local and private addresses (localhost, 192.168.x.x) ask first unless your message names them. Web search is not affected.'));
}

// ================= projects =================

/** One project: its folder, conversations, instructions and rules, and its check command. */
function tabProject(el, show, m, p) {
  const g = projectList().find((x) => x.path === p);
  if (!g) return el.append(h('p', { class: 'set-note' }, 'This project is no longer in the list.'));
  const reveal = (x) => api.post('/api/fs/reveal', { path: x }).catch((e) => toast(e.message, 'error'));
  const n = g.sessions.length;
  const rules = h('div', { class: 'set-after' }, loadingState('Reading the project’s rules…'));
  el.append(
    group('Folder', null,
      row('Location', btn('Show in Explorer', () => reveal(g.path), 'sm'), h('code', { class: 'about-path', title: g.path }, g.path)),
      row('Conversations', btn('New conversation', () => (m.close(), emit('home', g.path)), 'sm'), `${n || 'No'} conversation${n === 1 ? '' : 's'}${g.latest ? `, last active ${ago(g.latest)}` : ''}.`)),
    n ? group('Recent conversations', null, ...g.sessions.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, 6).map((s) => row(h('span', { class: 'ell' }, s.title), btn('Open', () => (m.close(), emit('open-session', s)), 'sm'), `${ago(s.mtime)}${s.branch ? ` · ${s.branch}` : ''}`))) : '',
    rules,
    checkCommandGroup(g.path),
    g.saved ? group(null, null, row('Remove from ORBIX', btn('Remove', async () => {
      if (!(await confirmDialog('Remove from the list', `Remove ${g.name} from ORBIX? The folder and its conversations stay on disk; it comes back when you open it again.`, { ok: 'Remove' }))) return;
      try {
        S.workspaces = (await api.post('/api/workspaces/remove', { id: g.id })).workspaces;
        emit('sessions');
        show('general');
      } catch (e) {
        toast(e.message, 'error');
      }
    }, 'sm'), 'The folder and its conversations stay on disk.')) : '');
  const TRIG = { always_on: 'Always', model_decision: 'When relevant', glob: 'For matching files', manual: 'When you @mention it' };
  api.get(`/api/project/rules?ws=${encodeURIComponent(g.path)}`).then(({ instructions, rules: rs }) => {
    if (!rules.isConnected) return;
    const rowsI = instructions.map((f) => row(h('code', { class: 'set-l ell', title: f.path }, baseName(f.path)), btn('Show', () => reveal(f.path), 'sm'), `${f.path}${f.truncated ? ' · only the first part is used' : ''}`));
    const rowsR = rs.map((r) => row(h('span', { class: 'proj-l' }, h('code', null, r.name), h('span', { class: 'tag' }, TRIG[r.trigger])), btn('Show', () => reveal(r.path), 'sm'), r.description || r.globs || (r.trigger === 'always_on' ? 'Part of every prompt in this project.' : '')));
    replace(rules, group('Instructions and rules', 'AGENTS.md or CLAUDE.md from this folder up to the repository root, and rule files in .agents/rules. Your instructions for every project come first; these win when they disagree.',
      ...(rowsI.length || rowsR.length ? [...rowsI, ...rowsR] : [h('p', { class: 'set-none' }, 'None yet. Run /init in a conversation to write an AGENTS.md, or add Markdown files to .agents/rules (front matter "trigger: always_on", "model_decision", "glob" or "manual").')])));
  }, (e) => rules.isConnected && replace(rules, errorState(e.message, { title: 'Couldn’t read the project’s rules.' })));
}

/** Every project, for when there are more than the list shows. */
function tabProjects(el, show) {
  const draw = () => {
    clear(el);
    const add = btn('Open a folder…', async () => {
      const p = await folderPicker('');
      if (!p) return;
      try {
        S.workspaces = (await api.post('/api/workspaces', { path: p })).workspaces;
        emit('sessions');
        draw();
      } catch (e) {
        toast(e.message, 'error');
      }
    }, 'sm');
    const ps = projectList();
    el.append(h('div', { class: 'set-actions set-actions-top' }, add));
    if (!ps.length) return el.append(h('p', { class: 'set-note' }, 'No projects yet. Open a folder to start.'));
    el.append(h('div', { class: 'set-card' }, ps.map((g) => go(h('span', { class: 'proj-l' }, icon('folder', 14), g.name), h('span', null, h('code', { class: 'about-path', title: g.path }, g.path), h('br'), `${g.sessions.length} conversation${g.sessions.length === 1 ? '' : 's'}${g.latest ? ` · last active ${ago(g.latest)}` : ''}`), () => show(`proj:${g.path}`)))));
  };
  draw();
}

// ================= conversations =================

function tabConversations(el) {
  const draw = () => {
    clear(el);
    const archived = (Array.isArray(S.ui.archived) ? S.ui.archived : []).map((p) => S.sessions.find((x) => x.path === p)).filter(Boolean);
    el.append(group('Archived', 'Archive a conversation from its row in the sidebar (or press A on it): it leaves the list and stays on disk.',
      ...(archived.length ? [
        ...archived.slice(0, 50).map((s) => row(h('span', { class: 'ell' }, s.title), btn('Unarchive', () => (savePrefs({ archived: S.ui.archived.filter((x) => x !== s.path) }), draw()), 'sm'), `${baseName(s.cwdDisplay || s.cwd)} · ${ago(s.mtime)}`)),
        row('Unarchive all', btn('Unarchive all', () => (savePrefs({ archived: [] }), toast('Every archived conversation is back in the sidebar', 'ok', 1800), draw()), 'sm')),
      ] : [h('p', { class: 'set-none' }, 'No archived conversations.')])));
    const trash = h('div', { class: 'set-after' });
    el.append(trash);
    api.get('/api/sessions/trash').then(({ items }) => {
      if (!trash.isConnected) return;
      const empty = btn('Empty', async () => {
        if (!(await confirmDialog('Empty recently deleted', `Delete ${items.length} conversation${items.length === 1 ? '' : 's'} for good? This cannot be undone.`, { ok: 'Delete for good', danger: true }))) return;
        await api.post('/api/sessions/trash/empty').catch((e) => toast(e.message, 'error'));
        draw();
      }, 'sm danger');
      trash.replaceChildren(group('Recently deleted', 'Deleted conversations stay here for 30 days, then they are removed for good.',
        ...(items.length ? [
          ...items.map((it) => row(h('span', { class: 'ell' }, it.title), btn('Restore', async () => {
            try {
              await api.post('/api/sessions/restore', { name: it.name });
              await loadSessions();
              toast('Restored', 'ok', 1400);
              draw();
            } catch (e) {
              toast(e.message, 'error');
            }
          }, 'sm'), `${it.cwd ? `${baseName(it.cwd)} · ` : ''}deleted ${ago(it.deletedAt)}`)),
          row('Empty recently deleted', empty),
        ] : [h('p', { class: 'set-none' }, 'Nothing was deleted in the last 30 days.')])));
    }).catch((e) => trash.isConnected && trash.replaceChildren(errorState(e.message, { title: 'Couldn’t read recently deleted conversations.' })));
  };
  draw();
}

// ================= shortcuts =================

/** Keycaps for one combo. */
const caps = (combo) => h('span', { class: 'kc' }, comboParts(combo).map((x, i) => [i ? h('span', { class: 'kc-plus' }, '+') : null, kbd(x)]));

function tabKeys(el) {
  const q = h('input', { type: 'search', class: 'keys-q', placeholder: 'Filter shortcuts', 'aria-label': 'Filter shortcuts', spellcheck: 'false', autocomplete: 'off' });
  const reset = btn('Reset all', async () => {
    if (!(await confirmDialog('Reset shortcuts', 'Put every shortcut back to its default keys?', { ok: 'Reset all' }))) return;
    savePrefs({ keys: resetKeys(S.ui.keys) });
    draw();
  }, 'sm');
  const box = h('div');
  let recording = null; // { id, chip, off }
  const stopRecording = () => {
    recording?.off();
    recording = null;
  };
  const record = (a, slot) => {
    stopRecording();
    const chip = h('span', { class: 'kc-rec', role: 'status' }, 'Press keys…');
    slot.replaceWith(chip);
    const onKey = (e) => {
      if (!chip.isConnected || chip.closest('.closing')) return stopRecording();
      // Ahead of every other handler, so the keys you press set the shortcut instead of running one.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return stopRecording(), draw();
      const combo = comboOf(e);
      if (!combo) return; // a modifier on its own: wait for the key
      const why = comboProblem(combo);
      if (why) return (chip.textContent = `${combo}: ${why}`), chip.classList.add('bad');
      const { keys, takenFrom } = assignCombo(S.ui.keys, a.id, combo);
      stopRecording();
      savePrefs({ keys });
      if (takenFrom) toast(`${combo} now does “${a.label}”. It was “${takenFrom.label}”.`, 'info', 4000);
      draw();
    };
    const onBlur = () => (stopRecording(), draw());
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    recording = { id: a.id, off: () => (window.removeEventListener('keydown', onKey, true), window.removeEventListener('blur', onBlur)) };
  };
  const draw = () => {
    if (!box.isConnected && recording) stopRecording();
    const t = q.value.trim().toLowerCase();
    const keys = effectiveKeys(S.ui.keys);
    const custom = S.ui.keys || {};
    const groups = [...new Set(ACTIONS.map((a) => a.group))];
    const sections = groups.map((gname) => {
      const rows = ACTIONS.filter((a) => a.group === gname && (!t || `${a.label} ${keys[a.id].join(' ')}`.toLowerCase().includes(t))).map((a) => {
        const add = h('button', { class: 'kc-add', type: 'button', title: `Add keys for ${a.label}`, 'aria-label': `Add keys for ${a.label}` }, icon('plus', 13));
        add.addEventListener('click', () => record(a, add));
        const chips = keys[a.id].map((k) => h('span', { class: 'kc-chip' }, caps(k), h('button', { class: 'kc-del', type: 'button', title: `Remove ${k}`, 'aria-label': `Remove ${k} from ${a.label}`, onclick: () => (savePrefs({ keys: removeCombo(S.ui.keys, a.id, k) }), draw()) }, icon('trash', 12))));
        const changed = Array.isArray(custom[a.id]);
        return h('div', { class: 'set-row kc-row' },
          h('div', { class: 'set-k' }, h('div', { class: 'set-l' }, a.label), changed ? h('button', { class: 'link kc-reset', type: 'button', onclick: () => (savePrefs({ keys: resetKeys(S.ui.keys, a.id) }), draw()) }, 'Reset') : null),
          h('div', { class: 'set-v kc-v' }, chips.length ? chips : h('span', { class: 'kc-none' }, 'None'), add));
      });
      return rows.length ? h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, gname), h('div', { class: 'set-card' }, rows)) : null;
    });
    const fixed = FIXED.map(([title, list]) => {
      const rows = list.filter(([k, d]) => !t || `${k} ${d}`.toLowerCase().includes(t)).map(([k, d]) => h('div', { class: 'set-row kc-row' }, h('div', { class: 'set-k' }, h('div', { class: 'set-l' }, d)), h('div', { class: 'set-v kc-v' }, h('span', { class: 'kc-chip fixed' }, k.includes(' / ') || k.includes('…') ? h('span', { class: 'kc' }, kbd(k)) : caps(k)))));
      return rows.length ? h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, title, h('span', { class: 'set-sub-n' }, 'Fixed')), h('div', { class: 'set-card' }, rows)) : null;
    });
    const any = [...sections, ...fixed].some(Boolean);
    replace(box, any ? [...sections, ...fixed] : h('p', { class: 'set-none' }, 'No shortcut matches.'));
  };
  q.addEventListener('input', draw);
  q.addEventListener('keydown', (e) => e.key === 'Escape' && q.value && (e.stopPropagation(), e.preventDefault(), (q.value = ''), draw()));
  el.append(h('div', { class: 'keys-bar' }, q, reset), box);
  draw();
  return stopRecording;
}

// ================= notifications =================

function tabNotify(el) {
  const p = notifyPrefs();
  const set = (k) => (v) => savePrefs({ notify: { ...notifyPrefs(), [k]: v } });
  const perm = notifyPermission();
  const permText = { granted: 'Allowed', denied: 'Blocked in Windows', default: 'Not asked yet', unsupported: 'Not available here' }[perm] || perm;
  const allow = perm === 'default' ? btn('Allow', async () => {
    await askNotifyPermission();
    replace(el);
    tabNotify(el);
  }, 'sm primary') : h('span', { class: `about-v ${perm === 'granted' ? 'ok-text' : perm === 'denied' ? 'warn-text' : ''}` }, permText);
  const vol = Math.round((p.volume ?? 0.8) * 100);
  const volVal = h('span', { class: 'num range-v' }, `${vol}%`);
  const volume = h('input', { type: 'range', min: 0, max: 100, step: 5, value: vol, 'aria-label': 'Volume', disabled: p.sound ? null : true });
  volume.addEventListener('input', () => (volVal.textContent = `${volume.value}%`));
  volume.addEventListener('change', () => {
    set('volume')(Number(volume.value) / 100);
    chime(Number(volume.value) / 100);
  });
  const sound = toggle(p.sound, (v) => {
    set('sound')(v);
    volume.disabled = !v;
  }, 'Play a sound');
  el.append(
    group('Tell me', null,
      row('When the agent finishes', toggle(p.done, set('done'), 'When the agent finishes'), 'A reply or a task has ended.'),
      row('When the agent needs you', toggle(p.input, set('input'), 'When the agent needs you'), 'An approval or a question is waiting for you.'),
      row('When something fails', toggle(p.errors, set('errors'), 'When something fails'), 'A turn ended on an error: the provider refused, a limit was hit, or the connection broke.'),
      row('Only while ORBIX is in the background', toggle(p.onlyAway, set('onlyAway'), 'Only while ORBIX is in the background'), 'Off: also while ORBIX is in front.'),
      row('In-app notifications', toggle(p.inApp, set('inApp'), 'In-app notifications'), 'While ORBIX is in front: a short note when another conversation finishes or needs you.')),
    group('Windows', null,
      row('Windows notifications', allow, perm === 'denied' ? 'Allow them in Windows Settings → System → Notifications.' : 'The banner in the corner of the screen.'),
      window.orbixDesktop ? row('Flash the taskbar', toggle(p.flash, set('flash'), 'Flash the taskbar'), 'Until you open the window.') : null,
      window.orbixDesktop?.system ? row('Notification settings', btn('Open in Windows', () => window.orbixDesktop.system.openNotifications(), 'sm'), 'Banners, sound and Do not disturb for ORBIX.') : null),
    group('Sound', null,
      row('Play a sound', sound, 'A soft chime when the agent finishes or needs you.'),
      row('Volume', h('div', { class: 'row range-row' }, volume, volVal), 'Moving the slider plays the chime.')),
    group(null, null, row('Try it', btn('Send a test', () => attention('ORBIX', 'This is how ORBIX gets your attention.', { force: true }), 'sm'), 'Uses the choices above, even while ORBIX is in front.')));
}

// ================= browser =================

function tabBrowser(el, show) {
  const b = browserPrefs();
  const desk = desktopBrowser();
  const histN = () => (S.ui.browserHistory || []).length;
  const clearHist = btn('Clear', () => {
    clearBrowserHistory();
    toast('Browsing history cleared', 'ok', 1400);
    clearHist.disabled = true;
    histHint.textContent = 'No visited addresses.';
  }, 'sm');
  clearHist.disabled = !histN();
  const histHint = h('span', null, histN() ? `${histN()} visited address${histN() === 1 ? '' : 'es'}, used for suggestions in the address bar.` : 'No visited addresses.');
  const where = h('code', { class: 'about-path' }, b.downloads || 'Downloads');
  const changeDl = btn('Change…', async () => {
    const p = await folderPicker(b.downloads || '');
    if (!p) return;
    savePrefs({ browser: { ...browserPrefs(), downloads: p } });
    where.textContent = p;
    desk?.configure({ downloads: p });
  }, 'sm');
  el.append(
    group('Built-in browser', null,
      row('Open links in', seg('Open links in', [['external', 'External browser'], ['builtin', 'Built-in browser']], b.openLinks, (v) => savePrefs({ browser: { ...browserPrefs(), openLinks: v } })), desk ? 'Built-in opens links from replies in the side panel’s Browser tab, next to the conversation.' : 'In a web browser ORBIX can show only pages on this computer inside it; other links open in a new tab.'),
      desk ? row('Download location', changeDl, h('span', null, 'Where files downloaded in the built-in browser are saved: ', where)) : null,
      row('Browsing history', clearHist, histHint),
      desk ? row('Cookies and site data', btn('Clear', async () => {
        if (!(await confirmDialog('Clear site data', 'Sign out of every site in the built-in browser and clear its cookies, storage and cache?', { ok: 'Clear', danger: true }))) return;
        await desk.clearData();
        toast('Site data cleared', 'ok', 1400);
      }, 'sm'), 'Sign-ins, cookies and cached pages of the built-in browser. Your own browser is not touched.') : null),
    ...browserExtraGroups(),
    group('Agent', null,
      go('Network access rules', 'Which sites the agent may read with web_fetch.', () => show('network'))));
}

// ================= feedback =================

const ISSUES_NEW = 'https://github.com/chsxthwik/ORBIX/issues/new';
const KINDS = [
  ['bug', 'Bug report', 'What happened, what you expected, and the steps that lead to it.', 'bug'],
  ['feature', 'Feature request', 'What is missing in how you work, what would fix it, and how it would help.', 'enhancement'],
  ['model', 'Model or provider problem', 'The provider and model, what you did, and the error you saw.', 'bug'],
  ['general', 'General feedback', 'Anything else about ORBIX.', ''],
];

let fbDraft = null; // { kind, text } from a 👎 on a reply

/** Settings → Give feedback, started with a kind and some text (👎 → Report a problem). */
export function openFeedback(draft) {
  fbDraft = draft || null;
  return openSettings('feedback');
}

function tabFeedback(el) {
  const draft = fbDraft;
  fbDraft = null;
  let kind = KINDS.some(([k]) => k === draft?.kind) ? draft.kind : 'bug';
  const radios = h('div', { class: 'fb-kinds', role: 'radiogroup', 'aria-label': 'Feedback type' }, KINDS.map(([k, l]) => h('label', { class: 'fb-kind' }, h('input', { type: 'radio', name: 'fb-kind', value: k, checked: k === kind ? true : null, onchange: () => ((kind = k), sync()) }), h('span', null, l))));
  const guide = h('p', { class: 'set-note' });
  const title = h('input', { type: 'text', class: 'fb-title', placeholder: 'A short title', 'aria-label': 'Title', maxlength: 120 });
  const text = h('textarea', { class: 'fb-text', rows: 8, 'aria-label': 'Description' }, draft?.text || '');
  const diag = h('input', { type: 'checkbox', checked: true });
  const sync = () => {
    const k = KINDS.find(([x]) => x === kind);
    guide.textContent = k[2];
    text.placeholder = kind === 'feature' ? 'Describe the feature you would like…' : kind === 'general' ? 'What do you think of ORBIX?' : 'Describe what happened…';
  };
  sync();
  const facts = () => {
    const v = window.orbixDesktop?.versions;
    const b = S.env.backend;
    const conn = (S.engine?.providers || []).filter((p) => p.configured).map((p) => p.name);
    return [`ORBIX ${S.env.app.version}${window.orbixDesktop ? '' : ' (in a browser)'}`, v ? `Electron ${v.electron}` : '', S.env.app.os || '', `Commands run in ${b.kind === 'wsl' ? 'WSL' : 'Windows'}`, conn.length ? `Providers: ${conn.join(', ')}` : 'No provider connected', `Permission preset: ${S.engine?.approvals || 'ask'}`].filter(Boolean);
  };
  const preview = h('pre', { class: 'fb-facts' }, facts().join('\n'));
  const submit = () => {
    const body = text.value.trim();
    if (!body) return toast('Write a description first', 'error'), text.focus();
    const k = KINDS.find(([x]) => x === kind);
    const parts = [`**${k[1]}**`, '', body];
    if (diag.checked) parts.push('', '<details><summary>About this copy</summary>', '', facts().map((f) => `- ${f}`).join('\n'), '', '</details>');
    const t = title.value.trim() || body.split('\n')[0].slice(0, 80);
    const url = `${ISSUES_NEW}?title=${encodeURIComponent(t)}&body=${encodeURIComponent(parts.join('\n'))}${k[3] ? `&labels=${k[3]}` : ''}`;
    openLink(url.length > 7800 ? url.slice(0, 7800) : url);
    toast('Opened on GitHub. Check it there, then press Submit new issue.', 'ok', 4000);
  };
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Feedback type'), radios),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Description'), guide, title, text),
    h('section', { class: 'set-group' },
      h('label', { class: 'fb-check' }, diag, h('span', null, 'Attach version and setup facts')),
      preview,
      h('p', { class: 'set-note' }, 'Nothing is sent from ORBIX: the report opens in your browser as a new GitHub issue, and you send it from there. API keys, file contents and conversations are never included. Attach a screenshot there if it helps.')),
    h('div', { class: 'set-actions' }, btn('Continue on GitHub', submit, 'primary')));
  diag.addEventListener('change', () => (preview.hidden = !diag.checked));
  setTimeout(() => (text.focus({ preventScroll: true }), text.setSelectionRange(text.value.length, text.value.length)), 0);
}

// ================= worktrees =================

function tabWorktrees(el, show, m) {
  const RUN_STATE = { planning: 'Planning', awaiting_plan: 'Plan to review', question: 'Asked you a question', executing: 'Working', review: 'Changes to review', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted', kept: 'Branch kept' };
  const runs = allRuns().filter((r) => r.worktree && RUN_STATE[r.status]);
  const convs = [...S.tabs.values()].filter((t) => t.worktree && !t.dead);
  const reveal = (p) => api.post('/api/fs/reveal', { path: p }).catch((e) => toast(e.message, 'error'));
  if (!runs.length && !convs.length) {
    return el.append(h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'No worktrees right now'), h('p', null, 'A run works in its own worktree and branch, and so does a conversation started with "Separate branch" on Home. They show here until you apply, merge or discard them.')), btn('Open Runs', () => (m.close(), emit('open-run', null)), 'primary')));
  }
  if (runs.length) el.append(group('Runs', 'Each run has its own folder and branch. Open it to apply or discard its changes.', ...runs.map((r) => row(h('span', { class: 'ell' }, r.title), h('div', { class: 'row' }, btn('Open', () => (m.close(), emit('open-run', r.id)), 'sm'), r.workspace ? btn('Show', () => reveal(r.workspace), 'sm') : null), h('span', null, h('code', null, r.worktree.branch || ''), ` · ${RUN_STATE[r.status]} · ${baseName(r.project)} · ${ago(r.updatedAt)}`)))));
  if (convs.length) el.append(group('Conversations', 'Open conversations on their own branch. Review merges or discards them.', ...convs.map((t) => row(h('span', { class: 'ell' }, t.name), h('div', { class: 'row' }, btn('Open', () => (m.close(), emit('open-tab', t.id)), 'sm'), t.workspace ? btn('Show', () => reveal(t.workspace), 'sm') : null), h('span', null, h('code', null, t.worktree.branch || ''), t.worktree.baseBranch ? ` · from ${t.worktree.baseBranch}` : '')))));
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
  replace(el, roles, ratingsGroup(() => tabModels(el, show)));
  renderModelRoles(roles, engine);
}

/** Your 👍 and 👎 per model (Settings → Models), from the marks on replies. Nothing when you have rated none. */
function ratingsGroup(redraw) {
  const list = modelRatings();
  if (!list.length) return '';
  const tally = (r) => h('span', { class: 'rate-tally num' }, icon('thumb-up', 13), String(r.up), icon('thumb-down', 13), String(r.down));
  return group('Your ratings', 'The 👍 and 👎 you gave replies, per model. Kept on this PC only.',
    ...list.map((r) => row(h('code', null, r.model), tally(r))),
    row('', btn('Clear ratings', async () => {
      if (!(await confirmDialog('Clear ratings', 'Forget the counts for every model? The marks on replies stay.', { ok: 'Clear' }))) return;
      clearRatings();
      redraw();
    }, 'sm')));
}

// ================= appearance =================

function tabLook(el) {
  const u = S.ui;
  const theme = ({ koi: 'latte', dusk: 'nebula' })[u.theme] || u.theme || 'system';
  const setTheme = (v) => {
    const apply = () => savePrefs({ theme: v });
    // A soft crossfade between themes.
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
    else apply();
  };
  const card = ([v, l]) => h('button', { class: 'theme-c', type: 'button', role: 'radio', 'aria-checked': String(theme === v), onclick: (e) => {
    setTheme(v);
    for (const b of e.currentTarget.closest('.set-wrap, .modal, body').querySelectorAll('.theme-c')) b.setAttribute('aria-checked', String(b === e.currentTarget));
  } }, themePreview(v), h('span', { class: 'theme-n' }, h('span', null, l), icon('check', 13, 'theme-ok')));
  const themes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight'], ['frost', 'Frost'], ['graphite', 'Graphite']].map(card));
  const scenes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Scene theme' }, [['orbix', 'ORBIX'], ['sunset', 'Synthwave'], ['nebula', 'Nebula'], ['aurora', 'Aurora']].map(card));
  const palettes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Editor palette' }, [['tokyo', 'Tokyo Night'], ['mocha', 'Catppuccin Mocha'], ['rosepine', 'Rosé Pine'], ['nord', 'Nord'], ['dracula', 'Dracula'], ['gruvbox', 'Gruvbox'], ['latte', 'Catppuccin Latte'], ['dawn', 'Rosé Pine Dawn']].map(card));
  // Theme as three icons (System, Light, Dark); the presets below choose any of the themes.
  const modeOf = (t) => (t === 'system' ? 'system' : ['light', 'frost', 'latte', 'dawn'].includes(t) ? 'light' : 'dark');
  const modeSeg = h('div', { class: 'seg seg-ic', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([v, ic, l]) => h('button', { type: 'button', role: 'radio', title: l, 'aria-label': l, 'aria-checked': String(modeOf(theme) === v), onclick: (e) => {
    for (const x of e.currentTarget.parentNode.children) x.setAttribute('aria-checked', String(x === e.currentTarget));
    setTheme(v);
    for (const b of el.querySelectorAll('.theme-c')) b.setAttribute('aria-checked', 'false');
  } }, icon(ic, 14))));
  const sizes = [12, 13, 14, 15, 16, 17, 18];
  const fontSize = pick('Font size', sizes.map((n) => [String(n), `${n}px`]), String(u.fontSize || 14), (v) => savePrefs({ fontSize: Number(v) }));
  const font = pick('Font', [['google', 'Google Sans'], ['segoe', 'Segoe UI'], ['system', 'System font']], ['segoe', 'system'].includes(u.font) ? u.font : 'google', (v) => savePrefs({ font: v }));
  // Your own colours for the theme in use: background, text and accent. Empty = the theme's own.
  const colors = { ...(u.colors || {}) };
  const css = getComputedStyle(document.documentElement);
  const toHex = (v) => {
    const m = /^#([0-9a-f]{6})$/i.exec(String(v).trim());
    if (m) return `#${m[1].toUpperCase()}`;
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = String(v).trim() || '#000';
    return /^#[0-9a-f]{6}$/i.test(c.fillStyle) ? c.fillStyle.toUpperCase() : '#000000';
  };
  const colorRow = (key, label, cssVar) => {
    const now = () => colors[key] || toHex(css.getPropertyValue(cssVar));
    const swatch = h('input', { type: 'color', class: 'clr-sw', value: now(), 'aria-label': `${label} colour` });
    const hex = h('input', { type: 'text', class: 'clr-hex', value: now().slice(1), maxlength: 6, spellcheck: 'false', 'aria-label': `${label} hex` });
    const save = (v) => {
      if (!/^#[0-9a-f]{6}$/i.test(v)) return;
      colors[key] = v.toUpperCase();
      swatch.value = v;
      hex.value = v.slice(1).toUpperCase();
      savePrefs({ colors: { ...colors } });
      reset.disabled = false;
    };
    swatch.addEventListener('input', () => save(swatch.value));
    hex.addEventListener('change', () => save(`#${hex.value.replace(/^#/, '')}`));
    hex.addEventListener('keydown', (e) => e.key === 'Enter' && hex.blur());
    return row(label, h('label', { class: 'clr' }, swatch, h('span', { class: 'clr-hash' }, '#'), hex));
  };
  const reset = btn('Reset', () => {
    savePrefs({ colors: {} });
    replace(el);
    tabLook(el);
  }, 'sm');
  reset.disabled = !Object.keys(colors).length;
  el.append(
    group('Chat', null,
      row('Conversation steps', seg('Conversation steps', [['default', 'Default'], ['verbose', 'Verbose']], u.steps === 'verbose' ? 'verbose' : 'default', (v) => savePrefs({ steps: v })), 'Default folds each turn’s steps into “Worked for…”. Verbose keeps them open.'),
      row('Show model thinking', toggle(u.showThinking !== false, (v) => savePrefs({ showThinking: v }), 'Show model thinking'), 'Folded above the reply until you open it.')),
    group('Theme and text', null,
      row('Theme', modeSeg),
      row('Contrast', seg('Contrast', [['default', 'Default'], ['strong', 'Strong']], u.contrast === 'strong' ? 'strong' : 'default', (v) => savePrefs({ contrast: v }))),
      row('Font', font),
      row('Font size', fontSize, 'Conversation text. Ctrl+= and Ctrl+- change it too.')),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Presets'), themes),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Editor palettes'),
      h('p', { class: 'set-note' }, 'The palettes developers rate highest, with their published colours for surfaces, text and code.'),
      palettes),
    group('Colors', 'Background, text and accent for the theme in use. Borders and muted text follow from them.',
      colorRow('bg', 'Background', '--bg'),
      colorRow('fg', 'Foreground', '--fg'),
      colorRow('accent', 'Accent', '--accent'),
      row('Theme colors', reset, 'Back to the theme’s own colors.')),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Scenes'),
      h('p', { class: 'set-note' }, 'A moving picture behind the conversation. It speeds up while the agent works; fireworks go off when a task finishes.'),
      scenes,
      h('div', { class: 'set-card scene-opts' },
        row('Animate scenes', toggle(u.sceneMotion !== false, (v) => savePrefs({ sceneMotion: v }), 'Animate scenes'), 'Off keeps the picture still. Windows’ reduce-motion setting does the same.'),
        row('Preview the finish', btn('Fireworks', () => previewCelebration()), 'What a scene does when a task finishes.'))),
    group('Chat layout', null,
      row('Conversation width', seg('Conversation width', [['narrow', 'Narrow'], ['default', 'Default'], ['wide', 'Wide'], ['fill', 'Fill']], colWidth(), (v) => setColWidth(v)), 'Widest the conversation and message box get.'),
      window.orbixDesktop ? row('Interface size', scaleSelect(u), 'Scales the whole window. 100% respects Windows display scaling without enlarging it again.') : null,
      row('Density', seg('Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], u.density === 'compact' ? 'compact' : 'comfortable', (v) => savePrefs({ density: v })), 'Compact fits more rows and steps on screen.')),
    ...lookExtraGroups(),
    group('Sidebar', null,
      row('Sort projects', seg('Sort projects', [['recent', 'Recent activity'], ['name', 'Name']], u.sortProjects === 'name' ? 'name' : 'recent', (v) => savePrefs({ sortProjects: v }))),
      row('Show archived conversations', toggle(u.showArchived === true, (v) => savePrefs({ showArchived: v }), 'Show archived conversations'))),
    group('Accessibility', null,
      row('Screen reader mode', toggle(u.screenReader === true, (v) => savePrefs({ screenReader: v }), 'Screen reader mode'), 'No animation, and every turn’s steps stay open so they are read in order.')));
}

/** Interface size in the Windows app. A legacy Auto value is treated as 100%. */
function scaleSelect(u) {
  const cur = typeof u.uiScale === 'number' && u.uiScale >= 0.5 && u.uiScale <= 2 ? u.uiScale : 1;
  const opts = [...new Set([0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, cur])].sort((a, b) => a - b);
  const select = h('select', { class: 'scale-sel', 'aria-label': 'Interface size', onchange: (e) => savePrefs({ uiScale: Number(e.target.value) }) }, opts.map((v) => h('option', { value: v, selected: v === cur }, `${Math.round(v * 100)}%${v === 1 ? ' (Default)' : ''}`)));
  return h('div', { class: 'row' }, select, btn('Reset', () => {
    select.value = '1';
    return savePrefs({ uiScale: 1 });
  }, 'sm'));
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

// ================= tool permissions =================

function tabBehavior(el) {
  const mode = S.engine?.approvals || 'ask';
  const set = async (value, card) => {
    if (value === 'auto' && !(await confirmFull())) return;
    if (await saveEngine({ approvals: value })) for (const b of card.parentElement.children) b.setAttribute('aria-checked', String(b === card));
  };
  const choice = (value, ic, title, text, tag) => h('button', { class: `perm is-${value}`, type: 'button', role: 'radio', 'aria-checked': String(mode === value), onclick: (e) => e.currentTarget.getAttribute('aria-checked') !== 'true' && set(value, e.currentTarget) },
    h('span', { class: 'perm-ic' }, icon(ic, 16)),
    h('span', { class: 'perm-m' }, h('span', { class: 'perm-h' }, h('span', { class: 'perm-t' }, title), tag ? h('span', { class: 'tag' }, tag) : null), h('span', { class: 'perm-d' }, text)),
    h('span', { class: 'perm-r', 'aria-hidden': 'true' }));
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'File edits and commands'), h('p', { class: 'set-note' }, 'Reading and searching never ask.'),
      h('div', { class: 'perms', role: 'radiogroup', 'aria-label': 'File edits and commands' },
        MODES.map(([value, title, text, ic]) => choice(value, ic, title, text, value === 'ask' ? 'Recommended' : '')))),
    trustedGroup(),
    group('Where commands run', null, whereRow()));
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
  onEnter(input, add);
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
  el.append(
    group('After the agent changes files', 'When the agent says it is done. A failing check goes back to the agent to fix before it replies.',
      row('Run the project’s check', seg('Run the project’s check', [['off', 'Off'], ['ask', 'Ask'], ['always', 'Always']], eng.verify || 'ask', (v) => saveEngine({ verify: v })), 'Always still waits for your OK unless the command is trusted or the preset allows it.'),
      row('Review the changes', toggle(eng.review !== false, (v) => saveEngine({ review: v }), 'Review the changes'), 'The fast model reads the diff once and reports defects for the agent to fix. Skipped under 5 changed lines.')),
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
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  api.get(`/api/engine/check?ws=${encodeURIComponent(ws)}`).then(show).catch((e) => (found.textContent = e.message));
  onEnter(input, () => save(input.value));
  return h('section', { class: 'set-group' }, head,
    h('p', { class: 'set-note' }, 'For ', h('bdi', null, ws), '. Leave the box empty to use the command found in the project.'),
    h('div', { class: 'set-card trust-card' }, found, h('div', { class: 'trust-add' }, input, btn('Save', () => save(input.value), 'sm'), btn('No check in this project', () => save('off'), 'sm ghost'))));
}

// ================= instructions =================

/** Settings → Instructions → For some models: extra instructions for models whose id contains a given text. */
function modelRulesGroup() {
  let rules = (S.engine?.modelRules || []).map((r) => ({ ...r }));
  const list = h('div', { class: 'mr-list' });
  const status = h('span', { class: 'rules-status', role: 'status' });
  const save = async () => {
    try {
      await api.post('/api/engine/settings', { modelRules: rules });
      await loadEngine();
      status.textContent = 'Saved. New turns of matching models follow these.';
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const draw = () => {
    list.replaceChildren(...rules.map((r, i) => {
      const match = h('input', { type: 'text', class: 'mr-match', value: r.match, placeholder: 'Part of the model id, e.g. deepseek', 'aria-label': 'Model', maxlength: 80, spellcheck: 'false' });
      const text = h('textarea', { class: 'rules-ta mr-text', rows: 3, placeholder: 'What this model should do differently', 'aria-label': 'Instructions for this model', maxlength: 8000 }, r.text);
      match.addEventListener('change', () => ((r.match = match.value.trim()), save()));
      text.addEventListener('change', () => ((r.text = text.value.trim()), save()));
      return h('div', { class: 'mr-item' }, h('div', { class: 'mr-row' }, match, btn('Remove', () => ((rules = rules.filter((_, j) => j !== i)), draw(), save()), 'sm danger')), text);
    }), rules.length ? '' : h('p', { class: 'set-note' }, 'No model-specific instructions yet.'));
  };
  draw();
  return h('section', { class: 'set-group' },
    h('div', { class: 'mr-head' }, h('h4', { class: 'set-sub' }, 'For some models'), btn('Add', () => (rules.push({ match: '', text: '' }), draw(), list.querySelector('.mr-item:last-child .mr-match')?.focus()), 'sm')),
    h('p', { class: 'set-note' }, 'Added after the instructions above when the model id contains the text you give. ORBIX’s own agent only; agent CLIs keep their own instructions.'),
    list,
    h('div', { class: 'rules-foot' }, h('span', { class: 'grow' }), status));
}

/** Settings → Instructions → Conversation names: the prompt the fast model gets to name a new conversation. */
function titlePromptGroup() {
  const DEFAULT = 'Reply with only a title of 2 to 6 words saying what the user wants done (the task, not a file, folder or project name): no quotes, no trailing punctuation, same language as the message.';
  const ta = h('textarea', { class: 'rules-ta', rows: 4, spellcheck: 'true', 'aria-label': 'How to name conversations', placeholder: `Built in: ${DEFAULT}`, maxlength: 4000 }, S.engine?.titlePrompt || '');
  const status = h('span', { class: 'rules-status', role: 'status' });
  let saved = ta.value;
  const save = async () => {
    if (ta.value.trim() === saved.trim()) return;
    try {
      await api.post('/api/engine/settings', { titlePrompt: ta.value });
      await loadEngine();
      saved = ta.value;
      status.textContent = ta.value.trim() ? 'Saved. New conversations are named this way.' : 'Cleared: the built-in naming is back.';
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  ta.addEventListener('input', () => (status.textContent = ''));
  ta.addEventListener('change', save);
  return h('section', { class: 'set-group' },
    h('h4', { class: 'set-sub' }, 'Conversation names'),
    h('p', { class: 'set-note' }, 'How a new conversation is named after your first message. Leave it empty for the built-in naming. Saved when you leave the box.'),
    ta,
    h('div', { class: 'rules-foot' }, h('span', { class: 'grow' }), status));
}

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
      status.textContent = r.text ? 'Saved. New messages in every conversation follow these instructions.' : 'Cleared.';
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
      h('p', { class: 'set-note' }, 'Plain text or Markdown. A project’s AGENTS.md or CLAUDE.md wins when the two disagree.'),
      failed,
      ta,
      h('div', { class: 'rules-foot' }, count, h('span', { class: 'grow' }), status, saveBtn)),
    titlePromptGroup(),
    modelRulesGroup());
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
  const sel = h('select', { class: 'set-select', 'aria-label': 'Run commands in' }, h('option', { value: 'native|' }, 'Windows'), b.kind === 'wsl' ? h('option', { value: cur }, (b.distro ? `WSL · ${b.distro}` : 'WSL · default distribution')) : null);
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
      toast('Saved. New conversations run commands there.', 'ok', 3500);
    } catch (e) {
      toast(e.message, 'error');
      sel.value = cur;
    }
  });
  return row('Run commands in', sel, 'In WSL, Windows drives appear as /mnt/c, /mnt/d and so on.');
}

// ================= application =================

const COMX_URL = 'https://comx-site.vercel.app';

const RELEASES_URL = 'https://github.com/chsxthwik/ORBIX/releases';

/** Settings → About → Updates, in the Windows app. It redraws itself as the status changes. */
function updatesGroup(onDispose) {
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
      row('Update automatically', toggle(st.auto, (v) => setAutoUpdates(v), 'Update automatically'), 'Downloads from GitHub in the background and verifies each download. Settings and conversations are kept.')));
  };
  const off = on('update', draw);
  onDispose(off);
  draw();
  return box;
}

const SITE_URL = 'https://orbix-agent.vercel.app';
const REPO_URL = 'https://github.com/chsxthwik/ORBIX';
const LICENSE_URL = 'https://github.com/chsxthwik/ORBIX/blob/main/LICENSE';

/** The facts a bug report needs, one per line. */
function versionInfo() {
  const v = window.orbixDesktop?.versions;
  const b = S.env.backend;
  return [
    `ORBIX ${S.env.app.version}${window.orbixDesktop ? '' : ' (run in a browser)'}`,
    v ? `Electron ${v.electron} · Chromium ${v.chrome} · Node.js ${v.node}` : '',
    S.env.app.os || '',
    `Commands run in ${b.kind === 'wsl' ? `WSL${b.distro ? ` (${b.distro})` : ''}` : 'Windows'}`,
  ].filter(Boolean).join('\n');
}

/** A small pill next to the version: where the update stands. Nothing outside the Windows app. */
function updatePill(onDispose) {
  if (!updatesSupported()) return '';
  const pill = h('button', { class: 'about-pill', type: 'button' });
  let drawn = false;
  const draw = () => {
    if (drawn && !pill.isConnected) return off();
    drawn = true;
    const st = S.update;
    const [text, tone] = { ready: [`${st.version} is ready`, 'on'], downloading: [`Downloading ${st.percent || 0}%`, ''], checking: ['Checking…', ''], latest: ['Up to date', 'ok'], error: ['Update failed', 'warn'] }[st.state] || [st.auto ? 'Updates on' : 'Updates off', ''];
    pill.className = `about-pill ${tone}`.trim();
    pill.title = updateLine(st);
    pill.onclick = st.state === 'ready' ? () => restartToUpdate() : () => pill.closest('.set-content')?.querySelector('.about-upd')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    replace(pill, h('span', { class: 'dot' + (tone === 'ok' ? ' ok' : tone === 'warn' ? ' warn' : tone === 'on' ? ' live' : '') }), text);
  };
  const off = on('update', draw);
  onDispose(off);
  draw();
  return pill;
}

const extLink = (label, url) => h('button', { class: 'about-link', type: 'button', title: url, onclick: () => openLink(url) }, label, icon('external', 12));

function tabApplication(el, show) {
  const b = S.env.backend;
  const v = window.orbixDesktop?.versions;
  const data = S.env.app.data || '';
  const mark = asciiComx();
  const cleanups = [mark.destroy];
  const onDispose = (fn) => cleanups.push(fn);
  el.append(
    h('header', { class: 'about-h' }, logoTile(44),
      h('div', { class: 'about-id' },
        h('div', { class: 'about-name' }, h('strong', null, 'ORBIX'), h('span', { class: 'tag on', title: 'Features and screens may still change between versions.' }, 'Beta')),
        h('div', { class: 'about-ver' }, h('span', { class: 'num' }, `Version ${S.env.app.version}`), updatePill(onDispose))),
      btn('Copy version info', async (e) => {
        const b2 = e.currentTarget;
        if (!(await copyText(versionInfo(), { quiet: true }))) return toast('Copy failed. Click into ORBIX and try again.', 'error');
        b2.textContent = 'Copied';
        setTimeout(() => (b2.textContent = 'Copy version info'), 1600);
      }, 'sm about-copy')),
    window.orbixDesktop?.system ? group('General', null,
      row('Keep awake', pick('Keep awake', [['off', 'Off'], ['work', 'While agents work'], ['always', 'Always, screen on']], keepAwakeMode(), (v) => savePrefs({ keepAwake: v })), 'While agents work: the PC stays awake while a conversation or run works, and 10 minutes after; the screen may still turn off. Always: awake with the screen on while ORBIX is open. Closing the lid or choosing Sleep still sleeps it.'),
      row('Keep running in the tray', toggle(S.ui.tray === true, (on) => savePrefs({ tray: on }), 'Keep running in the tray'), 'Closing the window hides ORBIX to the tray, so loops keep running.')) : '',
    h('div', { class: 'about-upd' }, updatesGroup(onDispose)),
    group('This copy', null,
      v ? row('Runtime', h('span', { class: 'about-v num' }, `Electron ${v.electron}`), `Chromium ${v.chrome} · Node.js ${v.node}`) : null,
      S.env.app.os ? row('System', h('span', { class: 'about-v' }, S.env.app.os)) : null,
      go('Commands run in', S.env.backend.kind === 'wsl' ? `WSL${S.env.backend.distro ? ` (${S.env.backend.distro})` : ''}` : 'Windows', () => show('behavior', 'Run commands in')),
      data ? row('Data folder', btn('Open', () => api.post('/api/reveal-data').catch((e) => toast(e.message, 'error')), 'sm'), h('span', null, h('code', { class: 'about-path', title: data }, data), h('br'), 'Settings, conversations and logs. Kept through updates.')) : null),
    group('Help', null,
      go('How ORBIX works', 'Connecting a model, approvals, undo and project rules.', () => openHelp()),
      go('Check my setup', 'Data folder, WSL and model, and what to fix.', () => openDiagnostics())),
    h('section', { class: 'about-maker', 'aria-label': 'Developed by COM-X Innovations, Inc.' },
      mark.el,
      h('div', { class: 'about-maker-t' },
        h('span', { class: 'about-by' }, 'Developed by'),
        h('strong', null, 'COM-X Innovations, Inc.'),
        h('button', { class: 'link', type: 'button', title: COMX_URL, onclick: () => openLink(COMX_URL) }, 'Visit COM-X', icon('external', 12)))),
    h('nav', { class: 'about-links', 'aria-label': 'ORBIX links' }, extLink('Website', SITE_URL), extLink('GitHub', REPO_URL), extLink('Release notes', RELEASES_URL), extLink('License', LICENSE_URL)),
    group(null, null,
      row('Quit ORBIX', btn('Quit', async () => {
        if (await confirmDialog('Quit ORBIX', 'Stop all conversations and close ORBIX?', { ok: 'Quit', danger: true })) {
          await api.post('/api/quit').catch(() => {});
        }
      }, 'sm danger'), 'Stops every running conversation and closes the window. A downloaded update installs now.')),
    h('p', { class: 'about-legal' }, '© 2026 QUANTUM, COM-X Innovations, Inc. Open source under the MIT License. Google Sans Flex and Geist Mono are used under the SIL Open Font License.'));
  return () => cleanups.forEach((cleanup) => cleanup());
}
