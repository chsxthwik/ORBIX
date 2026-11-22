// The side panel's Terminal tab (Ctrl+`): real shells on a pty (src/pty.mjs) drawn by xterm.js, several per project,
// one or two at once (Split stacks them). Each project keeps its terminals while you switch away; they live in the
// engine, so a reloaded window finds them again with their recent output. xterm.js loads the first time the tab opens.
import { h, icon, iconBtn, toast, copyText } from './dom.js';
import { api } from './api.js';
import { activeTab, on } from './store.js';
import { homeProject } from './home.js';
import { showTab, panelTab } from './panels.js';
import { confirmDialog } from './dialogs.js';
import { termFontSize, askBeforeKillTerminal } from './prefs-extra.js';

let dock = null; // { el, head, tabs, panes, split, kill }
let XT = null;
const byWs = new Map(); // ws -> { list: [term], cur: id, split: bool, loading }
const byId = new Map(); // pty id -> term { id, n, ws, mode, xt, fit, host, line, sending, queue, alive }

/** xterm.js and its fit add-on, from web/vendor (loaded once, on first use). */
function loadXterm() {
  if (XT) return XT;
  const script = (src) => new Promise((res, rej) => document.head.append(h('script', { src, onload: res, onerror: () => rej(new Error(`Could not load ${src}`)) })));
  document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/xterm/xterm.css' }));
  XT = script('/vendor/xterm/xterm.js').then(() => script('/vendor/xterm/addon-fit.js')).then(() => ({ Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon }));
  XT.catch(() => (XT = null));
  return XT;
}

const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
function theme() {
  const light = document.documentElement.dataset.mode === 'light';
  const base = light
    ? { foreground: '#1F1F1D', cursor: '#0A0A0B', cursorAccent: '#FFFFFF', selectionBackground: 'rgba(255,46,126,.22)',
        black: '#1F1F1D', red: '#C8263E', green: '#2F7D16', yellow: '#946200', blue: '#2557C9', magenta: '#B0247A', cyan: '#127D8C', white: '#6B6B66',
        brightBlack: '#5A5A55', brightRed: '#E0344F', brightGreen: '#3B9A1D', brightYellow: '#B07700', brightBlue: '#3A6FE0', brightMagenta: '#D0308F', brightCyan: '#1898A8', brightWhite: '#1F1F1D' }
    : { foreground: '#E4E4E0', cursor: '#F4F4F0', cursorAccent: '#0A0A0B', selectionBackground: 'rgba(255,46,126,.30)',
        black: '#2A2A2E', red: '#FF6B6B', green: '#8FD694', yellow: '#E8C27A', blue: '#6FA8FF', magenta: '#FF79B4', cyan: '#5FD7E8', white: '#C9C9C4',
        brightBlack: '#6E6E73', brightRed: '#FF8F8F', brightGreen: '#A9E8AD', brightYellow: '#F3D394', brightBlue: '#94BEFF', brightMagenta: '#FF9CCB', brightCyan: '#8EEEFF', brightWhite: '#F4F4F0' };
  return { ...base, background: css('--term-bg', light ? '#FFFFFF' : '#0A0A0B') };
}

/** The project the Terminal works for: the open conversation's, else Home's. */
const project = () => activeTab()?.workspace || homeProject() || '';
export const terminalShown = () => panelTab() === 'console' && !!document.querySelector('#panel')?.getClientRects().length && !!project();

// ---------------------------------------------------------------- input
function send(t, data) {
  t.queue += data;
  if (t.sending) return;
  t.sending = true;
  // Keystrokes typed while one request is on its way go together in the next, in order.
  const next = () => {
    const d = t.queue;
    t.queue = '';
    if (!d) return void (t.sending = false);
    api.post('/api/pty/input', { id: t.id, data: d }).catch((e) => toast(e.message, 'error')).finally(next);
  };
  queueMicrotask(next);
}

/** Line mode (PowerShell on a Windows folder): the line is edited here and sent on Enter. */
function lineKey(t, d) {
  for (const ch of d) {
    if (ch === '\r') {
      t.xt.write('\r\n');
      send(t, t.line);
      t.line = '';
    } else if (ch === '\x7f' || ch === '\b') {
      if (t.line) (t.line = t.line.slice(0, -1)), t.xt.write('\b \b');
    } else if (ch === '\x03') {
      t.line = '';
      api.post('/api/pty/interrupt', { id: t.id }).catch(() => {});
    } else if (ch === '\x15') {
      t.xt.write('\b \b'.repeat([...t.line].length));
      t.line = '';
    } else if (ch >= ' ' || ch === '\t') {
      t.line += ch;
      t.xt.write(ch);
    }
  }
}

// xterm's DOM renderer writes its sizes and colours into <style> elements, which ORBIX's Content-Security-Policy
// (style-src 'self', no inline styles) refuses. Its document is given a stand-in that makes those elements inert
// <xterm-style> tags; their text is copied into one constructed stylesheet, which the policy allows.
const sheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
const docShim = new Proxy(document, {
  get(target, prop) {
    if (prop === 'createElement') return (tag, opts) => target.createElement(String(tag).toLowerCase() === 'style' ? 'xterm-style' : tag, opts);
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' ? v.bind(target) : v;
  },
});
let sheetRaf = 0;
const syncSheet = () => {
  cancelAnimationFrame(sheetRaf);
  sheetRaf = requestAnimationFrame(() => sheet.replaceSync([...document.querySelectorAll('xterm-style')].map((s) => s.textContent).join('\n')));
};
const styleWatch = new MutationObserver(syncSheet);

// ---------------------------------------------------------------- terminals
async function attach(view) {
  const { Terminal, FitAddon } = await loadXterm();
  if (byId.has(view.id)) return byId.get(view.id);
  const xt = new Terminal({
    fontFamily: css('--mono', 'Consolas, monospace'), fontSize: termFontSize(), lineHeight: 1.25, letterSpacing: 0,
    cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, scrollback: 8000, allowTransparency: false,
    convertEol: false, smoothScrollDuration: 0, theme: theme(), minimumContrastRatio: 1, drawBoldTextInBrightColors: false,
    documentOverride: docShim,
  });
  const fit = new FitAddon();
  xt.loadAddon(fit);
  const host = h('div', { class: 'term-host' });
  const t = { ...view, xt, fit, host, line: '', queue: '', sending: false, sizeKey: '' };
  byId.set(t.id, t);
  styleWatch.observe(host, { subtree: true, childList: true, characterData: true });
  xt.open(host);
  syncSheet();
  if (view.buffer) xt.write(view.buffer);
  xt.onData((d) => (t.mode === 'line' ? lineKey(t, d) : send(t, d)));
  xt.onResize(({ cols, rows }) => {
    const k = `${cols}x${rows}`;
    if (k === t.sizeKey) return;
    t.sizeKey = k;
    api.post('/api/pty/resize', { id: t.id, cols, rows }).catch(() => {});
  });
  // Ctrl+C copies when text is selected (else it interrupts); Ctrl+Shift+C copies; Ctrl+V pastes.
  xt.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && k === 'c' && (e.shiftKey || xt.hasSelection())) {
      if (xt.hasSelection()) copyText(xt.getSelection()).then(() => xt.clearSelection());
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && !e.altKey && k === 'v') return false; // the browser's paste reaches xterm as a paste
    if (e.ctrlKey && (e.key === '`' || e.code === 'Backquote')) return false; // the app's toggle
    return true;
  });
  host.addEventListener('mousedown', () => focusTerm(t));
  return t;
}

function focusTerm(t) {
  const s = byWs.get(t.ws);
  if (s && s.cur !== t.id) {
    s.cur = t.id;
    drawHead();
  }
  t.xt.focus();
}

async function openNew(ws) {
  const s = state(ws);
  try {
    const { pty } = await api.post('/api/pty/open', { ws, cols: 100, rows: 24 });
    const t = await attach(pty);
    s.list.push(t);
    s.cur = t.id;
    return t;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

async function closeTerm(t) {
  const s = byWs.get(t.ws);
  api.post('/api/pty/close', { id: t.id }).catch(() => {});
  byId.delete(t.id);
  t.xt.dispose();
  t.host.remove();
  syncSheet();
  if (!s) return;
  const i = s.list.indexOf(t);
  s.list.splice(i, 1);
  if (s.cur === t.id) s.cur = s.list[Math.max(0, i - 1)]?.id || '';
  if (!s.list.length) s.split = false;
  draw();
}

const state = (ws) => byWs.get(ws) || byWs.set(ws, { list: [], cur: '', split: false, loaded: false }).get(ws);

/** The project's terminals: the engine's (after a reload), else a new one. */
async function ensure(ws) {
  const s = state(ws);
  if (s.loaded) return s;
  s.loaded = true;
  try {
    const { ptys } = await api.get(`/api/pty/list?ws=${encodeURIComponent(ws)}`);
    for (const v of ptys) s.list.push(await attach(v));
    s.cur ||= s.list.at(-1)?.id || '';
  } catch {}
  if (!s.list.length) await openNew(ws);
  return s;
}

// ---------------------------------------------------------------- the surface
function drawHead() {
  const s = byWs.get(project());
  if (!dock || !s) return;
  const tabs = s.list.length > 1 ? s.list.map((t) => h('button', { class: 'tt' + (t.id === s.cur ? ' cur' : ''), type: 'button', title: `Terminal ${t.n}`, onclick: () => ((s.cur = t.id), draw(), t.xt.focus()) }, icon('terminal', 12), String(t.n))) : [];
  const cur = byId.get(s.cur);
  dock.tabs.replaceChildren(h('span', { class: 'td-name' }, cur?.mode === 'line' ? 'PowerShell' : 'Shell'), ...tabs);
  dock.split.classList.toggle('on', s.split);
  dock.split.setAttribute('aria-pressed', String(s.split));
  dock.split.disabled = dock.kill.disabled = !s.list.length;
}

function draw() {
  const s = byWs.get(project());
  if (!dock || !s) return;
  if (!s.list.length) {
    // Every terminal was killed: one button brings a new one.
    dock.panes.replaceChildren(h('div', { class: 'empty td-empty' }, h('span', { class: 'empty-ic', 'aria-hidden': 'true' }, icon('terminal', 17)), h('span', null, 'No terminal open.'), h('button', { class: 'btn sm', type: 'button', onclick: () => newTerm() }, 'New terminal')));
    dock.panes.classList.remove('split');
    return drawHead();
  }
  const curIdx = Math.max(0, s.list.findIndex((t) => t.id === s.cur));
  const shown = s.split && s.list.length > 1 ? [s.list[curIdx], s.list[curIdx + 1] || s.list[curIdx - 1]] : [s.list[curIdx]];
  const want = shown.filter(Boolean).map((t) => t.host);
  if (want.length !== dock.panes.children.length || want.some((x, i) => dock.panes.children[i] !== x)) dock.panes.replaceChildren(...want);
  dock.panes.classList.toggle('split', want.length > 1);
  drawHead();
  requestAnimationFrame(fitAll);
}

function fitAll() {
  for (const host of dock?.panes.children || []) {
    const t = [...byId.values()].find((x) => x.host === host);
    if (t && host.clientWidth > 40 && host.clientHeight > 20) try { t.fit.fit(); } catch {}
  }
}

async function newTerm() {
  const t = await openNew(project());
  if (t) (draw(), t.xt.focus());
}

/** The side panel's Terminal tab: the project's terminals in `body` (made the first time, kept afterwards). */
export async function drawTerminal(body, { focus = false } = {}) {
  build();
  body.append(dock.el);
  const ws = project();
  if (!ws) return;
  if (!byWs.get(ws)?.loaded) dock.panes.replaceChildren(h('div', { class: 'td-wait' }));
  await ensure(ws);
  if (ws !== project() || !dock.el.isConnected) return;
  draw();
  if (focus) byId.get(byWs.get(ws)?.cur)?.xt.focus();
}

/** Show the Terminal tab, or close the side panel when it already shows it (Ctrl+`, View → Terminal). */
export function toggleTerminal(force) {
  if (!project()) return toast('Open a project first.', 'info', 2200);
  const shown = terminalShown();
  if (force === false || (force !== true && shown)) return shown && closePanel();
  showTab('console');
}

/** Run a command in the project's terminal (project scripts): it opens the Terminal tab and types the line. */
export async function runInTerminal(command) {
  if (!project()) return;
  showTab('console');
  await ensure(project());
  const t = byId.get(byWs.get(project())?.cur) || (await openNew(project()));
  if (!t) return;
  draw();
  if (t.mode === 'line') {
    t.xt.write(command + '\r\n');
    send(t, command);
  } else send(t, command + '\r');
  t.xt.focus();
}

let closePanel = () => {};
/** `close`: how to close the side panel (from main.js). */
export function mountTerminal({ close }) {
  closePanel = close;
  on('pty', (g) => {
    const t = byId.get(g.id);
    if (t && g.out) t.xt.write(g.out);
  });
  on('prefs', (p) => {
    if (p && ('theme' in p || 'mode' in p)) requestAnimationFrame(() => byId.forEach((t) => (t.xt.options.theme = theme())));
    // Settings → Appearance → Terminal font size: open terminals follow, and fit their new columns.
    if (p && 'termFontSize' in p) (byId.forEach((t) => (t.xt.options.fontSize = termFontSize())), requestAnimationFrame(fitAll));
  });
  new MutationObserver(() => byId.forEach((t) => (t.xt.options.theme = theme()))).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-theme'] });
}

function build() {
  if (dock) return;
  const tabs = h('div', { class: 'td-tabs' });
  const split = iconBtn('columns', 'Split', async () => {
    const s = state(project());
    s.split = !s.split;
    if (s.split && s.list.length < 2) await openNew(project());
    draw();
  }, 'sm td-split');
  const kill = iconBtn('trash', 'Kill terminal', async () => {
    const t = byId.get(byWs.get(project())?.cur);
    if (!t) return;
    if (askBeforeKillTerminal() && !(await confirmDialog('Kill terminal', 'Kill this terminal? Anything still running in it stops.', { ok: 'Kill terminal', danger: true }))) return;
    closeTerm(t);
  }, 'sm');
  const head = h('div', { class: 'p-bar td-head' }, icon('terminal', 14), tabs, h('span', { class: 'grow' }), split, iconBtn('plus', 'New terminal', () => newTerm(), 'sm'), kill);
  const panes = h('div', { class: 'td-panes' });
  const el = h('section', { class: 'termsurf', 'aria-label': 'Terminal' }, head, panes);
  dock = { el, head, tabs, panes, split, kill };
  let raf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitAll);
  }).observe(panes);
}
