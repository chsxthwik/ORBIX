// Extra preferences: code font and size, word wrap, animations, diff colours, time format,
// confirmations and the address bar's search engine. Each one is applied here (applyExtraPrefs) or read where it
// is used (fmtMsgTime, askBeforeDelete, askBeforeClose, searchUrl), so every row on a settings page does something.
import { h, toast } from './dom.js';
import { S, savePrefs, loadEngine, emit } from './store.js';
import { api } from './api.js';
import { row, toggle } from './dialogs.js';
import { group, pick, seg } from './settings-controls.js';

/** Code fonts: [value, label, CSS stack]. Empty stack = the theme's own (Geist Mono). */
const CODE_FONTS = [
  ['default', 'Geist Mono', ''],
  ['cascadia', 'Cascadia Code', "'Cascadia Code', 'Cascadia Mono', Consolas, ui-monospace, monospace"],
  ['consolas', 'Consolas', "Consolas, 'Cascadia Mono', ui-monospace, monospace"],
  ['system', 'System monospace', 'ui-monospace, monospace'],
];
const CODE_SIZES = [11, 12, 13, 14, 15, 16];
const PROMPT_SIZES = [13, 14, 15, 16, 17, 18];
export const TERM_SIZES = [11, 12, 13, 14, 15, 16, 18];
/** The terminal's text size (Settings → Appearance → Terminal font size); 12.5 by default. */
export const termFontSize = (u = S.ui) => (TERM_SIZES.includes(u.termFontSize) ? u.termFontSize : 12.5);

/** Address bar searches: [value, label, URL with %s for the query]. */
export const SEARCH_ENGINES = [
  ['duckduckgo', 'DuckDuckGo', 'https://duckduckgo.com/?q=%s'],
  ['google', 'Google', 'https://www.google.com/search?q=%s'],
  ['bing', 'Bing', 'https://www.bing.com/search?q=%s'],
  ['brave', 'Brave Search', 'https://search.brave.com/search?q=%s'],
  ['kagi', 'Kagi', 'https://kagi.com/search?q=%s'],
  ['ecosia', 'Ecosia', 'https://www.ecosia.org/search?q=%s'],
  ['custom', 'Custom', ''],
];

/** A custom search address must be http(s) and hold %s where the words go. */
export const customSearchOk = (v) => /^https?:\/\/[^\s]+$/i.test(String(v || '').trim()) && String(v).includes('%s');

/** The web search for words typed in the address bar, with the engine chosen in Settings → Browser. */
export function searchUrl(q, u = S.ui) {
  const words = encodeURIComponent(String(q || '').trim());
  if (u?.searchEngine === 'custom' && customSearchOk(u.searchCustomUrl)) return u.searchCustomUrl.trim().replace('%s', words);
  const tpl = SEARCH_ENGINES.find(([k]) => k === u?.searchEngine)?.[2] || SEARCH_ENGINES[0][2];
  return tpl.replace('%s', words);
}

/** Put the Appearance choices on the page root: classes and variables that prefs.css reads. */
export function applyExtraPrefs(u, root = document.documentElement) {
  const font = CODE_FONTS.find(([k]) => k === u.codeFont)?.[2];
  if (font) root.style.setProperty('--mono', font);
  else root.style.removeProperty('--mono');
  if (CODE_SIZES.includes(u.codeFontSize)) {
    root.style.setProperty('--code-fs', `${u.codeFontSize}px`);
    root.dataset.codeFs = '1';
  } else {
    root.style.removeProperty('--code-fs');
    delete root.dataset.codeFs;
  }
  if (PROMPT_SIZES.includes(u.promptFontSize)) {
    root.style.setProperty('--prompt-fs', `${u.promptFontSize}px`);
    root.dataset.promptFs = '1';
  } else {
    root.style.removeProperty('--prompt-fs');
    delete root.dataset.promptFs;
  }
  root.classList.toggle('no-smooth', u.fontSmoothing === false);
  root.classList.toggle('wrap-code', u.wrapCode === true);
  root.classList.toggle('no-motion', u.motion === 'off');
  if (u.diffColors === 'blue-orange') root.dataset.diff = 'blue-orange';
  else delete root.dataset.diff;
}

/**
 * A date formatter for these options, made once and reused. toLocaleString() builds a new formatter on every call,
 * which costs milliseconds each across the thousands of messages a long conversation shows.
 */
const formatters = new Map();
export function dateFormat(opts) {
  const key = JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat([], opts)));
  return f;
}

/** A message's time as chosen in Settings → Preferences: relative ("5m ago"), or the clock in 12 or 24 hours. */
export function fmtMsgTime(ts, relative) {
  const f = S.ui.timeFormat;
  if (f !== '12h' && f !== '24h') return relative(ts);
  const d = new Date(ts);
  const time = dateFormat({ hour: 'numeric', minute: '2-digit', hour12: f === '12h' }).format(d);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(d)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  return `${dateFormat({ month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).format(d)}, ${time}`;
}

/** Whether deleting a conversation asks first (it goes to Recently deleted either way). */
export const askBeforeDelete = () => S.ui.confirmDelete !== false;
/** Whether closing a conversation that is still working asks first. */
export const askBeforeClose = () => S.ui.confirmClose !== false;
/** Off by default: archiving and unpinning are one click and easy to take back. */
export const askBeforeArchive = () => S.ui.confirmArchive === true;
export const askBeforeUnpin = () => S.ui.confirmUnpin === true;
/** Whether killing a terminal (and what runs in it) asks first. */
export const askBeforeKillTerminal = () => S.ui.confirmTerminalClose !== false;
/** Keep awake: 'off', 'work' (while agents work, and 10 minutes after) or 'always' (screen on while ORBIX is open). */
export const keepAwakeMode = (u = S.ui) => (['off', 'work', 'always'].includes(u.keepAwake) ? u.keepAwake : u.preventSleep === true ? 'work' : 'off');
/** Whether the sidebar shows the Running section (working conversations and ones that need you) on top. */
export const showRunningSection = () => S.ui.sidebarRunning !== false;
/** Whether skills are listed with the slash commands in the message box. */
export const skillsInSlashMenu = () => S.ui.skillsInSlash !== false;

// ---- rows for the settings pages ----

/** Settings → Appearance: Code, Diffs and Motion. */
export function lookExtraGroups() {
  const u = S.ui;
  return [
    group('Code', null,
      row('Code font', pick('Code font', CODE_FONTS.map(([k, l]) => [k, l]), CODE_FONTS.some(([k]) => k === u.codeFont) ? u.codeFont : 'default', (v) => savePrefs({ codeFont: v })), 'Code blocks, diffs and file previews.'),
      row('Code font size', pick('Code font size', [['default', 'Default'], ...CODE_SIZES.map((n) => [String(n), `${n}px`])], CODE_SIZES.includes(u.codeFontSize) ? String(u.codeFontSize) : 'default', (v) => savePrefs({ codeFontSize: v === 'default' ? null : Number(v) }))),
      row('Word wrap', toggle(u.wrapCode === true, (v) => savePrefs({ wrapCode: v }), 'Word wrap'), 'Wrap long lines instead of scrolling sideways.')),
    group('Layout', null,
      row('Conversations as tabs', toggle(u.topTabs === true, (v) => savePrefs({ topTabs: v }), 'Conversations as tabs'), 'Open conversations as tabs under the toolbar.')),
    group('Text', null,
      row('Message box font size', pick('Message box font size', [['default', 'Default'], ...PROMPT_SIZES.map((n) => [String(n), `${n}px`])], PROMPT_SIZES.includes(u.promptFontSize) ? String(u.promptFontSize) : 'default', (v) => savePrefs({ promptFontSize: v === 'default' ? null : Number(v) })), 'The text you type.'),
      row('Terminal font size', pick('Terminal font size', [['default', 'Default'], ...TERM_SIZES.map((n) => [String(n), `${n}px`])], TERM_SIZES.includes(u.termFontSize) ? String(u.termFontSize) : 'default', (v) => savePrefs({ termFontSize: v === 'default' ? null : Number(v) })), 'Open terminals update at once.'),
      row('Font smoothing', toggle(u.fontSmoothing !== false, (v) => savePrefs({ fontSmoothing: v }), 'Font smoothing'), 'Thinner letters. Off uses system rendering.'),
      row('Reasoning level', seg('Reasoning level', [['label', 'Name'], ['bars', 'Bars']], u.effortDisplay === 'bars' ? 'bars' : 'label', (v) => savePrefs({ effortDisplay: v })), 'How the message box shows the reasoning level.')),
    group('Diffs', null,
      row('Ignore whitespace', toggle(u.diffIgnoreWs === true, (v) => savePrefs({ diffIgnoreWs: v }), 'Ignore whitespace'), 'Hide whitespace-only changes in the Changes panel.'),
      row('Diff colors', seg('Diff colors', [['red-green', 'Red & green'], ['blue-orange', 'Blue & orange']], u.diffColors === 'blue-orange' ? 'blue-orange' : 'red-green', (v) => savePrefs({ diffColors: v })), 'Blue & orange suits red-green color blindness.')),
    group('Motion', null,
      row('Animations', seg('Animations', [['full', 'On'], ['off', 'Off']], u.motion === 'off' ? 'off' : 'full', (v) => savePrefs({ motion: v })), 'Off: panels and menus change at once.')),
  ];
}

/** Settings → Preferences: Time format and Confirmations. */
export function generalExtraGroups() {
  const u = S.ui;
  return [
    group('Time', null,
      row('Time format', seg('Time format', [['relative', 'Relative'], ['12h', '12-hour'], ['24h', '24-hour']], ['12h', '24h'].includes(u.timeFormat) ? u.timeFormat : 'relative', (v) => savePrefs({ timeFormat: v })), 'Message times. The exact time is always in the tooltip.')),
    group('Sidebar', null,
      row('Running section', toggle(showRunningSection(), (v) => savePrefs({ sidebarRunning: v }), 'Running section'), 'Working conversations and ones that need you, at the top.')),
    group('Message box', null,
      row('Skills in the slash menu', toggle(skillsInSlashMenu(), (v) => savePrefs({ skillsInSlash: v }), 'Skills in the slash menu'), 'List skills with commands when you type /.')),
    group('Git', null,
      row('No AI credit in commits', toggle(S.engine?.noCoAuthor === true, async (v) => {
        try {
          await api.post('/api/engine/settings', { noCoAuthor: v });
          await loadEngine();
          emit('engine');
        } catch (e) {
          toast(e.message, 'error');
        }
      }, 'No AI credit in commits'), 'No Co-authored-by or “generated with” lines, from ORBIX’s agent or Claude Code.')),
    group('Confirmations', null,
      row('Ask before deleting a conversation', toggle(askBeforeDelete(), (v) => savePrefs({ confirmDelete: v }), 'Ask before deleting a conversation'), 'Deleted conversations can be restored for 30 days.'),
      row('Ask before closing a working conversation', toggle(askBeforeClose(), (v) => savePrefs({ confirmClose: v }), 'Ask before closing a working conversation'), 'Closing stops the agent.'),
      row('Ask before archiving a conversation', toggle(askBeforeArchive(), (v) => savePrefs({ confirmArchive: v }), 'Ask before archiving a conversation')),
      row('Ask before unpinning a conversation', toggle(askBeforeUnpin(), (v) => savePrefs({ confirmUnpin: v }), 'Ask before unpinning a conversation')),
      row('Ask before killing a terminal', toggle(askBeforeKillTerminal(), (v) => savePrefs({ confirmTerminalClose: v }), 'Ask before killing a terminal'), 'Stops what runs in it.')),
  ];
}

/** Save engine settings and reload them (the rows below read S.engine). */
async function engineSet(patch) {
  try {
    await api.post('/api/engine/settings', patch);
    await loadEngine();
    emit('engine');
  } catch (e) {
    toast(e.message, 'error');
  }
}

/** Settings → Agents: Command Guard, Claude Code's own subagents, and how long a retry may wait. */
export function agentOptionGroups() {
  const e = S.engine || {};
  return [
    group('Safety', null,
      row('Command Guard', toggle(e.commandGuard !== false, (v) => engineSet({ commandGuard: v }), 'Command Guard'), 'Blocks commands that wipe a disk, drive, home folder or hosted repository, for every agent. Not a sandbox.')),
    group('Claude Code', null,
      row('Claude Code subagents', toggle(e.claudeNoSubagents !== true, (v) => engineSet({ claudeNoSubagents: !v }), 'Claude Code subagents'), 'Off hides its Task tool, so it works in one thread. New conversations only.')),
    group('Retries', null,
      row('Longest automatic wait', pick('Longest automatic wait', [['0', 'Don’t wait'], ['60', '1 minute'], ['300', '5 minutes'], ['900', '15 minutes'], ['3600', '1 hour']], String(Number.isFinite(e.retryMaxWait) ? e.retryMaxWait : 60), (v) => engineSet({ retryMaxWait: Number(v) })), 'Retry a busy or rate-limited provider after its requested wait, up to this long.')),
  ];
}

/** Settings → Browser: the address bar's search engine. */
export function browserExtraGroups() {
  const u = S.ui;
  const cur = SEARCH_ENGINES.some(([k]) => k === u.searchEngine) ? u.searchEngine : 'duckduckgo';
  const custom = h('input', { type: 'text', class: 'trust-in', value: u.searchCustomUrl || '', placeholder: 'https://example.com/search?q=%s', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Custom search address' });
  const customHint = h('span', null, 'Put %s where the search words go.');
  const customRow = row('Custom search address', custom, customHint);
  customRow.hidden = cur !== 'custom';
  custom.addEventListener('change', () => {
    const v = custom.value.trim();
    if (v && !customSearchOk(v)) return (customHint.textContent = 'Use an http(s) address that contains %s.'), customHint.classList.add('warn-text');
    customHint.textContent = 'Put %s where the search words go.';
    customHint.classList.remove('warn-text');
    savePrefs({ searchCustomUrl: v });
  });
  return [
    group('Address bar', null,
      row('Search engine', pick('Search engine', SEARCH_ENGINES.map(([k, l]) => [k, l]), cur, (v) => {
        customRow.hidden = v !== 'custom';
        savePrefs({ searchEngine: v });
      }), 'For words typed in the built-in browser’s address bar.'),
      customRow),
  ];
}
