// Keyboard shortcuts you can change (Settings → Shortcuts). Every action has default keys; a change is saved in
// prefs.keys as { action: ['Ctrl+K', …] } and replaces that action's defaults (an empty list turns it off).
// Keys are named by their place on the keyboard (event.code), so they work the same on any layout:
// "Ctrl+Shift+/" is the key with / on it, held with Ctrl and Shift.

/** id, group, label, default keys, and when it may run: `field: false` = not while typing in a text field. */
export const ACTIONS = [
  { id: 'search', group: 'General', label: 'Search conversations, files and commands', keys: ['Ctrl+K'] },
  { id: 'files', group: 'General', label: 'Find a file', keys: ['Ctrl+P', 'Ctrl+Alt+P'] },
  { id: 'new', group: 'General', label: 'New conversation', keys: ['Ctrl+N', 'Ctrl+1'] },
  { id: 'runs', group: 'General', label: 'Runs', keys: ['Ctrl+2'] },
  { id: 'review', group: 'General', label: 'Review', keys: ['Ctrl+3'] },
  { id: 'automations', group: 'General', label: 'Loops', keys: ['Ctrl+U'] },
  { id: 'back', group: 'General', label: 'Go back', keys: ['Alt+←', 'Ctrl+['], field: false },
  { id: 'forward', group: 'General', label: 'Go forward', keys: ['Alt+→', 'Ctrl+]'], field: false },
  { id: 'nextConv', group: 'General', label: 'Next open conversation', keys: ['Ctrl+Tab'] },
  { id: 'prevConv', group: 'General', label: 'Previous open conversation', keys: ['Ctrl+Shift+Tab'] },
  { id: 'sidebar', group: 'General', label: 'Show or hide the sidebar', keys: ['Ctrl+B'] },
  { id: 'panel', group: 'Side panel', label: 'Show or hide the side panel', keys: ['Ctrl+J'] },
  { id: 'terminal', group: 'Side panel', label: 'Show or hide the terminal', keys: ['Ctrl+`', 'Ctrl+Alt+T'] },
  { id: 'nextPanelTab', group: 'Side panel', label: 'Next side panel tab', keys: ['Ctrl+Shift+.'] },
  { id: 'prevPanelTab', group: 'Side panel', label: 'Previous side panel tab', keys: ['Ctrl+Shift+,'] },
  { id: 'shortcuts', group: 'General', label: 'Keyboard shortcuts', keys: ['Ctrl+/'] },
  { id: 'settings', group: 'General', label: 'Open settings', keys: ['Ctrl+,'] },
  { id: 'connect', group: 'General', label: 'Connect a provider or agent', keys: ['Ctrl+Shift+M'] },
  { id: 'focusInput', group: 'Conversation', label: 'Focus the message box', keys: ['Ctrl+L'] },
  { id: 'find', group: 'Conversation', label: 'Find in the conversation', keys: ['Ctrl+F'] },
  { id: 'outline', group: 'Conversation', label: 'Jump to one of your messages', keys: ['Ctrl+Shift+O'] },
  { id: 'prevMine', group: 'Conversation', label: 'Previous message of yours', keys: ['Alt+↑'] },
  { id: 'nextMine', group: 'Conversation', label: 'Next message of yours', keys: ['Alt+↓'] },
  { id: 'sideQuestion', group: 'Side panel', label: 'Side question', keys: ['Ctrl+Alt+S'] },
  { id: 'inspector', group: 'Side panel', label: 'Inspect', keys: ['Ctrl+Alt+I', 'Ctrl+Shift+R'] },
  { id: 'surfReview', group: 'Side panel', label: 'Review (a conversation on its own branch)', keys: ['Ctrl+Alt+R'] },
  { id: 'surfBrowser', group: 'Side panel', label: 'Browser', keys: ['Ctrl+Alt+B'] },
  { id: 'surfIncognito', group: 'Side panel', label: 'Incognito browser', keys: ['Ctrl+Alt+N'] },
  { id: 'surfDevice', group: 'Side panel', label: 'Device (the page at phone size)', keys: ['Ctrl+Alt+M'] },
  { id: 'surfFiles', group: 'Side panel', label: 'Files', keys: ['Ctrl+Alt+F'] },
  { id: 'surfChanges', group: 'Side panel', label: 'Changes', keys: ['Ctrl+Alt+D'] },
  { id: 'surfTasks', group: 'Side panel', label: 'Tasks', keys: ['Ctrl+Alt+K'] },
  { id: 'surfContext', group: 'Side panel', label: 'Context (tokens, cost, the system prompt)', keys: ['Ctrl+Alt+C'] },
  { id: 'zen', group: 'Conversation', label: 'Focus mode', keys: ['Ctrl+Shift+F'] },
  { id: 'textBigger', group: 'Conversation', label: 'Bigger text', keys: ['Ctrl+='] },
  { id: 'textSmaller', group: 'Conversation', label: 'Smaller text', keys: ['Ctrl+-'] },
  { id: 'textReset', group: 'Conversation', label: 'Reset text size', keys: ['Ctrl+0'] },
];

/** Keys that are part of how a control works, listed in Settings but not changeable. */
export const FIXED = [
  ['Message box', [['Enter', 'Send (or Ctrl+Enter, see General)'], ['Shift+Enter', 'New line'], ['Alt+Enter', 'Send the other way while the agent works (steer or queue)'], ['Esc', 'Stop the agent'], ['/', 'Slash commands'], ['@', 'Mention a file'], ['↑', 'Your last message again, when the box is empty']]],
  ['Approvals', [['1', 'Allow once'], ['2', 'Allow for this conversation'], ['Esc', 'Deny']]],
  ['Sidebar', [['Alt+1…9', 'Open conversation 1 to 9'], ['F2', 'Rename the selected conversation'], ['P', 'Pin or unpin it'], ['A', 'Archive or unarchive it'], ['Del', 'Delete it (asks first)'], ['↑ / ↓', 'Move through the list']]],
];

const CODE = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
  Semicolon: ';', Quote: "'", Backquote: '`', NumpadAdd: '=', NumpadSubtract: '-', NumpadDivide: '/', NumpadDecimal: '.',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del', Space: 'Space',
  Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
};
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

/** "Ctrl+Shift+K" for a keydown event, or '' for a modifier alone. Ctrl, Alt, Shift always come in that order. */
export function comboOf(e) {
  if (!e || MODS.has(e.key)) return '';
  const c = String(e.code || '');
  let k = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^(Digit|Numpad)\d$/.test(c) ? c.slice(-1) : /^F([1-9]|1[0-9]|2[0-4])$/.test(c) ? c : CODE[c] || '';
  if (!k) {
    const key = String(e.key || '');
    if (!key || key === 'Unidentified' || key === 'Dead') return '';
    k = key.length === 1 ? key.toUpperCase() : key;
  }
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', k].filter(Boolean).join('+');
}

/** The key part and the modifiers of a combo: "Ctrl+Shift++" style names never occur (numpad + is "="). */
export const comboParts = (combo) => String(combo || '').split('+').filter(Boolean);

/**
 * Can this combo be a shortcut? It needs Ctrl or Alt (so typing is never taken over), or is a function key.
 * Returns '' when it can, or why not.
 */
export function comboProblem(combo) {
  const parts = comboParts(combo);
  if (!parts.length) return 'Press a key';
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (/^F\d{1,2}$/.test(key)) return '';
  if (!mods.includes('Ctrl') && !mods.includes('Alt')) return 'Use Ctrl or Alt with the key, or a function key (F1–F12)';
  if (['Esc', 'Enter'].includes(key) && mods.length === 1 && mods[0] === 'Alt') return 'Alt+Enter and Alt+Esc are taken by the message box';
  if (/^[1-9]$/.test(key) && mods.length === 1 && mods[0] === 'Alt') return 'Alt+1 to Alt+9 open conversations';
  return '';
}

/** Each action's keys now: your list where you changed it, else its defaults. */
export function effectiveKeys(custom) {
  const own = custom && typeof custom === 'object' ? custom : {};
  const out = {};
  for (const a of ACTIONS) out[a.id] = Array.isArray(own[a.id]) ? own[a.id].filter((k) => typeof k === 'string' && k).slice(0, 4) : a.keys;
  return out;
}

/** The action a combo runs, or null. With duplicates (only possible by hand-editing prefs) the first action wins. */
export function actionFor(combo, custom) {
  if (!combo) return null;
  const keys = effectiveKeys(custom);
  return ACTIONS.find((a) => keys[a.id].includes(combo)) || null;
}

/**
 * Give `combo` to `id`: added to its keys and taken from any other action that had it.
 * Returns { keys: the new prefs.keys, takenFrom: the action it was taken from or null }.
 */
export function assignCombo(custom, id, combo) {
  const now = effectiveKeys(custom);
  const out = { ...(custom || {}) };
  let takenFrom = null;
  for (const a of ACTIONS) {
    if (a.id !== id && now[a.id].includes(combo)) {
      out[a.id] = now[a.id].filter((k) => k !== combo);
      takenFrom = a;
    }
  }
  if (!now[id].includes(combo)) out[id] = [...now[id], combo].slice(-4);
  return { keys: tidy(out), takenFrom };
}

/** Take one combo off an action. */
export function removeCombo(custom, id, combo) {
  const now = effectiveKeys(custom);
  return tidy({ ...(custom || {}), [id]: now[id].filter((k) => k !== combo) });
}

/** Back to the defaults: one action, or all of them (id omitted). */
export function resetKeys(custom, id) {
  if (!id) return {};
  const out = { ...(custom || {}) };
  delete out[id];
  return out;
}

/** Drop entries that equal the defaults, so a later change of a default still reaches you. */
function tidy(custom) {
  const out = {};
  for (const a of ACTIONS) {
    const v = custom[a.id];
    if (Array.isArray(v) && !(v.length === a.keys.length && v.every((k, i) => k === a.keys[i]))) out[a.id] = v;
  }
  return out;
}

/** The first key of an action, for hints in menus ("Ctrl+K"), or ''. */
export const firstKey = (custom, id) => effectiveKeys(custom)[id]?.[0] || '';
