// Settings: a card over the workspace. Pages on the left (Settings, Customizations, one page per
// project, conversations and worktrees), Give feedback and this copy of ORBIX at the bottom. Esc or × closes it.
// Ctrl+K finds any setting by name (settingsSearchItems) and opens its page.
import { h, icon, iconBtn, toast, replace, clear, logo, errorState, loadingState, copyText, timeAgo, baseName, kbd } from './dom.js';
import { api } from './api.js';
import { S, on, savePrefs, engineReady, loadEngine, loadEnv, loadSessions, emit, groupSessions, activeTab } from './store.js';
import { toggleWide } from './workbench.js';
import { modal, btn, confirmDialog, row, toggle, folderPicker } from './dialogs.js';
import { notifyPrefs, attention, notifyPermission, askNotifyPermission, chime } from './notify.js';
import { allRuns } from './runs.js';
import { renderEngineSettings, openLink } from './engine.js';
import { brandMark } from './brands.js';
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

/** The pages in the list: [key, label, one line under the title]. Headings are { h }. */
const NAV = [
  { h: 'Settings' },
  ['general', 'General', 'Permissions, sending messages while the agent works, and the sites the agent may read.'],
  ['application', 'Application', 'Updates, where ORBIX keeps its data, and this copy.'],
  ['look', 'Appearance', 'Theme, scenes, text size and layout.'],
  ['keys', 'Shortcuts', 'Add keys to an action with +, remove them with the bin. Keys need Ctrl or Alt, or are a function key.'],
  ['notify', 'Notifications', 'When ORBIX gets your attention, and how.'],
  ['engine', 'Providers', 'Sign in, paste an API key or connect a local model. Keys are checked, stored encrypted for your Windows account and sent only to their provider.'],
  ['models', 'Models', 'Which model does which job.'],
  ['browser', 'Browser', 'Where links open, the built-in browser, its history and downloads.'],
  { h: 'Customizations' },
  ['rules', 'Instructions', 'What the agent should always know about you and how you work. It follows these in every project.'],
  ['checks', 'Checks', 'How the agent checks its own work before it replies.'],
  ['tools', 'Tools & MCP', 'What the agent can use, and the extra tools you add.'],
  { h: 'Projects', projects: true },
  { h: 'History' },
  ['conversations', 'Conversations', 'Archived conversations and the ones deleted in the last 30 days.'],
  ['worktrees', 'Worktrees', 'Runs and conversations that work on their own branch, in their own folder, apart from your checkout.'],
];
/** Pages reached from another page, with the page they belong to. */
const SUB = [
  ['behavior', 'Tool permissions', 'What the agent may do without asking, the commands you trust, and where it runs commands.', 'general'],
  ['network', 'Network access rules', 'Which sites the agent may read with web_fetch.', 'general'],
  ['projects', 'All projects', 'Every folder ORBIX knows, with its conversations.', null],
  ['feedback', 'Give feedback', 'Report a problem or ask for a feature. It opens as a GitHub issue that you check before you send it.', null],
];
const PAGES = [...NAV.filter((t) => Array.isArray(t)), ...SUB];
const OLD = { start: 'general', prefs: 'general', about: 'application' }; // page names from before 3.7

/** What Ctrl+K finds: [setting, page, extra words]. */
const FIND = [
  ['API keys', 'engine', 'provider key anthropic openai gemini openrouter connect sign in'],
  ['Local models', 'engine', 'ollama lm studio offline server custom'],
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
  ['Run commands in', 'behavior', 'shell wsl windows powershell kali'],
  ['Overview card', 'look', 'card overview panel'],
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
  ['Theme', 'look', 'dark light system midnight frost orbix scene synthwave koi aurora dusk animated backdrop fireworks color'],
  ['Message text size', 'look', 'font zoom bigger smaller'],
  ['Density', 'look', 'compact comfortable spacing rows'],
  ['Reading column', 'look', 'wide width'],
  ['Show model thinking', 'look', 'reasoning'],
  ['Keyboard shortcuts', 'keys', 'keys hotkeys keybindings rebind'],
  ['Updates', 'application', 'update upgrade new version check download install release'],
  ['Data folder', 'application', 'logs folder settings location'],
  ['Give feedback', 'feedback', 'bug report feature request issue problem'],
];

/** Ctrl+K: every setting, as search items that open its page. */
export function settingsSearchItems() {
  return FIND.map(([label, page, words]) => ({ group: 'Settings', scope: 'commands', searchOnly: true, icon: 'cog', label, hint: PAGES.find(([k]) => k === page)?.[1], text: words, run: () => openSettings(page, label) }));
}

/** Rows that belong together, in one framed list. */
const group = (title, note, ...rows) => h('section', { class: 'set-group' }, title ? h('h4', { class: 'set-sub' }, title) : null, note ? h('p', { class: 'set-note' }, note) : null, h('div', { class: 'set-card' }, ...rows));

/** The projects in the list: most recent first. */
const projectList = () => groupSessions().filter((g) => g.path).sort((a, b) => (b.latest || 0) - (a.latest || 0));
const MAX_PROJECTS = 8;

let current = null; // the open settings card, so a second open only changes its page

/** Open Settings on a page (general, look, keys, engine, …, or proj:<path>). `focus` points at one setting on it. */
export function openSettings(initial = 'general', focus = '') {
  initial = OLD[initial] || initial;
  if (current?.isOpen()) return current.show(initial, focus);
  const valid = (k) => PAGES.some(([p]) => p === k) || k.startsWith('proj:');
  let cur = valid(initial) ? initial : 'general';
  const list = h('div', { class: 'set-pages', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings pages' });
  const foot = h('div', { class: 'set-foot' });
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings' }, list, foot);
  const content = h('div', { class: 'set-content', role: 'tabpanel', tabindex: '-1' });
  const closeBtn = iconBtn('x', 'Close (Esc)', () => m.close(), 'set-close');
  const m = modal({ title: 'Settings', cls: 'settings settings-card', body: h('div', { class: 'set-wrap' }, nav, h('div', { class: 'set-main' }, closeBtn, content)), onClose: () => (current = null) });

  const tab = (key, label, extra = null) => h('button', { type: 'button', role: 'tab', id: `set-${key.replace(/[^\w-]/g, '_')}`, 'aria-selected': String(key === cur), tabindex: key === cur ? '0' : '-1', class: 'set-tab' + (key === cur ? ' cur' : ''), title: label, onclick: () => show(key) }, h('span', { class: 'ell grow' }, label), extra);
  const badge = (k) => {
    if (k !== 'engine') return null;
    return (S.engine?.providers || []).some((p) => p.configured) ? null : h('span', { class: 'dot warn', title: 'No model connected' });
  };
  const drawNav = () => {
    const out = [];
    for (const t of NAV) {
      if (Array.isArray(t)) out.push(tab(t[0], t[1], badge(t[0])));
      else if (t.projects) {
        const ps = projectList();
        if (!ps.length) continue;
        out.push(h('div', { class: 'set-nav-h' }, t.h));
        for (const g of ps.slice(0, MAX_PROJECTS)) out.push(tab(`proj:${g.path}`, g.name));
        if (ps.length > MAX_PROJECTS) out.push(tab('projects', `All projects (${ps.length})`));
      } else out.push(h('div', { class: 'set-nav-h' }, t.h));
    }
    replace(list, out);
    const eng = S.engine || {};
    const conn = (eng.providers || []).filter((p) => p.configured);
    replace(foot,
      tab('feedback', 'Give feedback'),
      h('button', { class: 'set-me', type: 'button', title: 'About this copy of ORBIX', onclick: () => show('application') },
        conn[0] ? h('span', { class: 'set-me-ic' }, brandMark(conn[0].id, 18)) : h('span', { class: 'set-me-ic' }, logo(18)),
        h('span', { class: 'set-me-t' }, h('b', null, `ORBIX ${S.env.app.version}`), h('small', { class: 'ell' }, conn.length ? `${conn.map((p) => p.name).join(', ')} connected` : 'No model connected'))));
  };

  const show = (name, focusLabel = '', focusNav = false) => {
    name = OLD[name] || name;
    if (!valid(name)) name = 'general';
    cur = name;
    drawNav();
    nav.querySelector('.set-tab.cur')?.scrollIntoView({ block: 'nearest' });
    content.setAttribute('aria-labelledby', `set-${name.replace(/[^\w-]/g, '_')}`);
    clear(content);
    content.scrollTop = 0;
    const body = h('div', { class: 'set-body' });
    if (name.startsWith('proj:')) {
      const p = name.slice(5);
      const g = projectList().find((x) => x.path === p);
      content.append(h('header', { class: 'set-head' }, h('h3', { class: 'set-title' }, g?.name || baseName(p)), h('p', { class: 'set-lead' }, h('bdi', null, p))), body);
      tabProject(body, show, m, p);
    } else {
      const page = PAGES.find(([k]) => k === name);
      const parent = page[3] && PAGES.find(([k]) => k === page[3]);
      content.append(h('header', { class: 'set-head' },
        parent ? h('button', { class: 'set-crumb', type: 'button', onclick: () => show(parent[0]) }, icon('arrow-left', 13), parent[1]) : null,
        h('h3', { class: 'set-title' }, page[1]), h('p', { class: 'set-lead' }, page[2])), body);
      ({ general: tabGeneral, application: tabApplication, look: tabLook, keys: tabKeys, notify: tabNotify, engine: renderEngineSettings, models: tabModels, browser: tabBrowser, rules: tabRules, checks: tabChecks, tools: renderMcpSettings, conversations: tabConversations, worktrees: tabWorktrees, behavior: tabBehavior, network: tabNetwork, projects: tabProjects, feedback: tabFeedback })[name](body, show, m);
    }
    if (focusLabel) pointAt(content, focusLabel);
    if (focusNav) nav.querySelector('.set-tab.cur')?.focus();
  };

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
  const offSessions = on('sessions', () => (content.isConnected ? drawNav() : offSessions()));
  show(cur, focus);
  setTimeout(() => nav.querySelector('.set-tab.cur')?.focus({ preventScroll: true }), 0);
  current = { isOpen: () => content.isConnected, show: (k, f) => show(OLD[k] || k, f) };
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

/** A pill select: [value, label] options. */
function pick(label, options, value, onPick) {
  const sel = h('select', { class: 'set-select', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  sel.addEventListener('change', () => onPick(sel.value, sel));
  return sel;
}

/** "just now", "5m ago", "on Nov 3". */
const ago = (ts) => {
  const t = timeAgo(ts);
  return t === 'now' ? 'just now' : /^\d+[mhd]$/.test(t) ? `${t} ago` : `on ${t}`;
};

const saveEngine = async (body, quiet = false) => {
  try {
    await api.post('/api/engine/settings', body);
    await loadEngine();
    if (!quiet) toast('Saved', 'ok', 1200);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
};

// ================= general =================

const MODES = [
  ['ask', 'Ask first', 'Each file edit and command waits for your OK.'],
  ['edits', 'Auto edits', 'File edits run without asking, and each one can be undone. Commands still wait for your OK.'],
  ['auto', 'Turbo', 'File edits and commands run without asking, also outside the project folder. Edits can be undone; commands cannot. Destructive commands still ask.'],
];

/** Ask before Turbo; returns whether to go on. */
const confirmTurbo = () => confirmDialog('Turn on Turbo', 'The agent will edit files and run commands without asking, also outside the project folder. Every file edit can still be undone, but commands cannot. Destructive commands (deleting folders, pushing, publishing) still ask.', { ok: 'Turn on Turbo', danger: true });

function tabGeneral(el, show) {
  const u = S.ui;
  const eng = S.engine || {};
  const mode = eng.approvals || 'ask';
  const modeHint = h('span', null, MODES.find(([k]) => k === mode)?.[2]);
  const preset = pick('Permission preset', MODES.map(([k, l]) => [k, l]), mode, async (v, sel) => {
    if (v === 'auto' && !(await confirmTurbo())) return (sel.value = S.engine?.approvals || 'ask');
    if (await saveEngine({ approvals: v })) modeHint.textContent = MODES.find(([k]) => k === v)?.[2];
    else sel.value = S.engine?.approvals || 'ask';
  });
  const net = eng.network || { allow: [], deny: [] };
  const netLine = net.allow.length ? `${net.allow.length} allowed site${net.allow.length === 1 ? '' : 's'} read without asking; others ask${net.deny.length ? `. ${net.deny.length} denied` : ''}.` : net.deny.length ? `Any site except ${net.deny.length} denied.` : 'Any site. Local and private addresses ask first.';
  el.append(
    engineReady() ? '' : h('div', { class: 'ov-cta' }, h('div', null, h('strong', null, 'Connect a model to start'), h('p', null, 'Use an API key, a sign-in or a model on this PC. Nothing else needs to be installed.')), btn('Connect a model', () => show('engine'), 'primary')),
    group('Permissions', null,
      row('Permission preset', preset, modeHint),
      row('Tool permissions', btn('Open', () => show('behavior'), 'sm'), `${(eng.trusted || []).length || 'No'} trusted command${(eng.trusted || []).length === 1 ? '' : 's'}. Commands run in ${S.env.backend.kind === 'wsl' ? 'WSL' : 'Windows'}.`),
      row('Network access rules', btn('Open', () => show('network'), 'sm'), netLine)),
    group('Messages', null,
      row('While the agent works', seg('While the agent works', [['steer', 'Steer'], ['queue', 'Queue']], u.whileBusy === 'queue' ? 'queue' : 'steer', (v) => savePrefs({ whileBusy: v })), 'What Enter does while the agent works. Steer: it reads your message at its next step. Queue: your message waits until it finishes. Alt+Enter does the other.'),
      row('Send messages with', seg('Send messages with', [['enter', 'Enter'], ['ctrl', 'Ctrl+Enter']], u.sendKey === 'ctrl' ? 'ctrl' : 'enter', (v) => savePrefs({ sendKey: v })), 'With Enter, Shift+Enter starts a new line. With Ctrl+Enter, Enter starts a new line.'),
      row('Follow new output', toggle(u.autoScroll !== false, (v) => savePrefs({ autoScroll: v }), 'Follow new output'), 'Scrolls to the newest text while a reply streams in, unless you have scrolled up.')),
    group('Checks', null,
      row('After the agent changes files', btn('Open', () => show('checks'), 'sm'), [{ off: 'The project’s check does not run', ask: 'Asks before running the project’s check', always: 'Runs the project’s check' }[eng.verify || 'ask'], eng.review === false ? '' : ', then reviews its changes once'].join('') + '.')));
}

// ================= network rules =================

function tabNetwork(el) {
  const editor = (key, title, note, placeholder) => {
    const listEl = h('div', { class: 'trust-list' });
    const input = h('input', { type: 'text', class: 'trust-in', placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': `Add to ${title.toLowerCase()}` });
    const items = () => (S.engine?.network || { allow: [], deny: [] })[key] || [];
    const save = async (next) => {
      if (await saveEngine({ network: { [key]: next } }, true)) draw();
    };
    const add = async () => {
      const v = input.value.trim();
      if (!v) return input.focus();
      const before = items().length;
      await save([...items(), v]);
      if (items().length === before) toast('That is not a site: use a name like example.com, *.example.com or example.com/docs.', 'error', 4500);
      else (input.value = ''), input.focus();
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
    function draw() {
      const list = items();
      replace(listEl, list.length ? list.map((r) => h('div', { class: 'trust-row' }, h('code', { class: 'ell', title: r }, r), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Remove ${r}`, onclick: () => save(list.filter((x) => x !== r)) }, 'Remove'))) : h('p', { class: 'set-none' }, key === 'allow' ? 'None. Every site that is not denied is read without asking.' : 'None.'));
    }
    draw();
    return h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, title), h('p', { class: 'set-note' }, note), h('div', { class: 'set-card trust-card' }, listEl, h('div', { class: 'trust-add' }, input, btn('Add', add, 'sm'))));
  };
  el.append(
    editor('allow', 'Allowed sites', 'Read without asking. When this list has sites, every other site asks first, in every permission preset. A site covers its subdomains; *.example.com covers only the subdomains; example.com/docs covers that path.', 'example.com, *.example.com or example.com/docs'),
    editor('deny', 'Denied sites', 'Never read, also when a page redirects there. A denied site wins over an allowed one. * denies every site.', 'example.com'),
    h('p', { class: 'set-note set-after-note' }, 'Local and private addresses (localhost, 192.168.x.x) still ask first unless you named them in your message. Web search results are not affected.'));
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
    el.append(h('div', { class: 'set-card' }, ps.map((g) => row(h('span', { class: 'proj-l' }, icon('folder', 14), g.name), btn('Open', () => show(`proj:${g.path}`), 'sm'), h('span', null, h('code', { class: 'about-path', title: g.path }, g.path), h('br'), `${g.sessions.length} conversation${g.sessions.length === 1 ? '' : 's'}${g.latest ? ` · last active ${ago(g.latest)}` : ''}`)))));
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
      row('Only while ORBIX is in the background', toggle(p.onlyAway, set('onlyAway'), 'Only while ORBIX is in the background'), 'Turn this off to be told even while you are looking at ORBIX.')),
    group('Windows', null,
      row('Windows notifications', allow, perm === 'denied' ? 'Allow them in Windows Settings → System → Notifications.' : 'The message in the corner of the screen.'),
      window.orbixDesktop ? row('Flash the taskbar', toggle(p.flash, set('flash'), 'Flash the taskbar'), 'The ORBIX button on the taskbar flashes until you open the window.') : null),
    group('Sound', null,
      row('Play a sound', sound, 'A short, soft chime when the agent finishes or needs you.'),
      row('Volume', h('div', { class: 'row range-row' }, volume, volVal), 'How loud the chime is. Moving the slider plays it.')),
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
    group('Agent', null,
      row('Sites the agent may read', btn('Open', () => show('network'), 'sm'), 'Network access rules for web_fetch: allowed and denied sites.')));
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
    text.placeholder = kind === 'feature' ? 'Describe the feature you would like…' : kind === 'general' ? 'Tell us what you think…' : 'Describe what happened…';
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
  replace(el, roles);
  renderModelRoles(roles, engine);
}

// ================= appearance =================

function tabLook(el) {
  const u = S.ui;
  const theme = u.theme || 'system';
  const card = ([v, l]) => h('button', { class: 'theme-c', type: 'button', role: 'radio', 'aria-checked': String(theme === v), onclick: (e) => {
    const apply = () => savePrefs({ theme: v });
    // A soft crossfade between themes.
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(apply);
    else apply();
    for (const b of e.currentTarget.closest('.set-wrap, .modal, body').querySelectorAll('.theme-c')) b.setAttribute('aria-checked', String(b === e.currentTarget));
  } }, themePreview(v), h('span', { class: 'theme-n' }, h('span', null, l), icon('check', 13, 'theme-ok')));
  const themes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light'], ['midnight', 'Midnight'], ['frost', 'Frost']].map(card));
  const scenes = h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Scene theme' }, [['orbix', 'ORBIX'], ['sunset', 'Synthwave'], ['koi', 'Koi pond'], ['aurora', 'Aurora'], ['dusk', 'Halftone dusk']].map(card));
  const val = h('span', { class: 'num range-v' }, `${u.fontSize || 14}px`);
  const size = h('input', { type: 'range', min: 12, max: 18, step: 1, value: u.fontSize || 14, 'aria-label': 'Message text size', oninput: () => ((val.textContent = size.value + 'px'), savePrefs({ fontSize: +size.value })) });
  el.append(
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Theme'), themes),
    h('section', { class: 'set-group' }, h('h4', { class: 'set-sub' }, 'Scenes'),
      h('p', { class: 'set-note' }, 'Themes with a moving picture behind the conversation. Text stays on a calm column in the middle, the scene speeds up while the agent works, and fireworks go up when a task finishes.'),
      scenes,
      h('div', { class: 'set-card scene-opts' },
      row('Animate scenes', toggle(u.sceneMotion !== false, (v) => savePrefs({ sceneMotion: v }), 'Animate scenes'), 'Turn this off to keep the picture still. Scenes also stay still when Windows is set to reduce motion.'),
      row('Preview the finish', btn('Fireworks', () => previewCelebration()), 'Shows what happens in a scene theme when the agent finishes a task.'))),
    group('Reading', null,
      row('Message text size', h('div', { class: 'row' }, size, val)),
      h('p', { class: 'fs-sample' }, 'The quick brown fox: this is how replies will read.'),
      row('Show model thinking', toggle(u.showThinking !== false, (v) => savePrefs({ showThinking: v }), 'Show model thinking'), 'Shows the model’s reasoning above its reply, folded until you open it.')),
    group('Layout', null,
      window.orbixDesktop ? row('Interface size', scaleSelect(u), 'Scales everything in the window. Auto picks a size for your screen and goes larger on wide, high-resolution screens.') : null,
      row('Density', seg('Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], u.density === 'compact' ? 'compact' : 'comfortable', (v) => savePrefs({ density: v })), 'Compact fits more rows in the sidebar and more steps on the screen.'),
      row('Reading column', seg('Reading column', [['normal', 'Normal'], ['wide', 'Wide']], document.documentElement.classList.contains('wide') ? 'wide' : 'normal', (v) => (v === 'wide') !== document.documentElement.classList.contains('wide') && toggleWide()), 'Wide suits long diffs and tables. The View menu has the same switch.'),
      row('Overview card', toggle(u.overview !== false, (v) => savePrefs({ overview: v }), 'Overview card'), 'The card beside the conversation with Changes, Files, Terminal and Plan.')),
    group('Sidebar', null,
      row('Sort projects', seg('Sort projects', [['recent', 'Recent activity'], ['name', 'Name']], u.sortProjects === 'name' ? 'name' : 'recent', (v) => savePrefs({ sortProjects: v }))),
      row('Show archived conversations', toggle(u.showArchived === true, (v) => savePrefs({ showArchived: v }), 'Show archived conversations'), 'Archived conversations stay on disk; Settings → Conversations lists them.')));
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

// ================= tool permissions =================

function tabBehavior(el) {
  const mode = S.engine?.approvals || 'ask';
  const set = async (value, card) => {
    if (value === 'auto' && !(await confirmTurbo())) return;
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
        choice('ask', 'shield', 'Ask first', 'Each file edit and command waits for your OK.', 'Recommended'),
        choice('edits', 'pencil', 'Auto edits', 'File edits run without asking, and each one can be undone. Commands still wait for your OK.'),
        choice('auto', 'bolt', 'Turbo', 'File edits and commands run without asking. Edits can be undone; commands cannot. Destructive commands still ask.'))),
    trustedGroup(),
    group('Running', null, whereRow()));
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
      row('Review the changes', toggle(eng.review !== false, (v) => save({ review: v }), 'Review the changes'), 'Before the reply, the fast model (or the conversation’s model) reads the changes once and reports real defects for the agent to fix. It is skipped when fewer than 5 lines changed.')),
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

/** Settings → Application → Updates, in the Windows app. It redraws itself as the status changes. */
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
function updatePill() {
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
  draw();
  return pill;
}

const extLink = (label, url) => h('button', { class: 'about-link', type: 'button', title: url, onclick: () => openLink(url) }, label, icon('external', 12));

function tabApplication(el, show) {
  const b = S.env.backend;
  const v = window.orbixDesktop?.versions;
  const data = S.env.app.data || '';
  el.append(
    h('header', { class: 'about-h' }, logo(44),
      h('div', { class: 'about-id' },
        h('div', { class: 'about-name' }, h('strong', null, 'ORBIX'), h('span', { class: 'tag on', title: 'Features and screens may still change between versions.' }, 'Beta')),
        h('div', { class: 'about-ver' }, h('span', { class: 'num' }, `Version ${S.env.app.version}`), updatePill())),
      btn('Copy version info', async (e) => {
        const b2 = e.currentTarget;
        if (!(await copyText(versionInfo(), { quiet: true }))) return toast('Copy failed. Click into ORBIX and try again.', 'error');
        b2.textContent = 'Copied';
        setTimeout(() => (b2.textContent = 'Copy version info'), 1600);
      }, 'sm about-copy')),
    h('p', { class: 'about-lead' }, 'A coding agent that works inside your projects, on your own computer. It reads freely, asks before it edits a file or runs a command, and lets you undo every edit.'),
    h('ul', { class: 'about-facts' },
      h('li', null, icon('shield', 15), h('div', null, h('strong', null, 'Asks first'), h('span', null, 'Edits and commands wait for your OK.'))),
      h('li', null, icon('undo', 15), h('div', null, h('strong', null, 'Undo any edit'), h('span', null, 'Every file change can be reverted.'))),
      h('li', null, icon('key', 15), h('div', null, h('strong', null, 'Your keys stay here'), h('span', null, 'Encrypted for your Windows account.')))),
    h('div', { class: 'about-upd' }, updatesGroup()),
    group('This copy', null,
      v ? row('Runtime', h('span', { class: 'about-v num' }, `Electron ${v.electron}`), `With Chromium ${v.chrome} and Node.js ${v.node}.`) : null,
      S.env.app.os ? row('System', h('span', { class: 'about-v' }, S.env.app.os)) : null,
      row('Commands run in', h('span', { class: 'about-v' }, b.kind === 'wsl' ? `WSL${b.distro ? ` · ${b.distro}` : ''}` : 'Windows'), h('span', null, 'Change it in ', h('button', { class: 'link', type: 'button', onclick: () => show('behavior') }, 'Tool permissions'), '.')),
      data ? row('Data folder', btn('Open', () => api.post('/api/reveal-data').catch((e) => toast(e.message, 'error')), 'sm'), h('span', null, h('code', { class: 'about-path', title: data }, data), h('br'), 'Settings, conversations and logs live here and stay through every update.')) : null),
    group('Help', null,
      row('How ORBIX works', btn('Open', () => openHelp(), 'sm'), 'A short guide to connecting a model, approvals, undo and project rules.'),
      row('Keyboard shortcuts', btn('Open', () => show('keys'), 'sm'), 'Every shortcut. Change the keys of any action.'),
      row('Check my setup', btn('Run', () => openDiagnostics(), 'sm'), 'Checks the data folder, WSL and your providers, and says what to fix.'),
      row('Report a problem', btn('Give feedback', () => show('feedback'), 'sm'), 'A bug, a feature you miss, or anything else. It opens as a GitHub issue you check before sending.')),
    h('section', { class: 'about-maker', 'aria-label': 'Made by COM-X Corporation' },
      asciiComx().el,
      h('div', { class: 'about-maker-t' },
        h('span', { class: 'about-by' }, 'Developed by'),
        h('strong', null, 'COM-X Corporation'),
        h('p', null, 'Company X finds the problems that matter most and builds their solutions. ORBIX is its coding workspace.'),
        h('button', { class: 'link', type: 'button', title: COMX_URL, onclick: () => openLink(COMX_URL) }, 'Visit COM-X', icon('external', 12)))),
    h('nav', { class: 'about-links', 'aria-label': 'ORBIX links' }, extLink('Website', SITE_URL), extLink('GitHub', REPO_URL), extLink('Release notes', RELEASES_URL), extLink('License', LICENSE_URL)),
    group(null, null,
      row('Quit ORBIX', btn('Quit', async () => {
        if (await confirmDialog('Quit ORBIX', 'Stop all conversations and close ORBIX?', { ok: 'Quit', danger: true })) {
          await api.post('/api/quit').catch(() => {});
        }
      }, 'sm danger'), 'Stops every running conversation and closes the window. A downloaded update installs now.')),
    h('p', { class: 'about-legal' }, '© 2026 chsxthwik. Licensed under FSL-1.1-MIT: free to use, and each release becomes MIT two years after it ships. Geist and Geist Mono are used under the SIL Open Font License.'));
}
