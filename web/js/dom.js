// Tiny DOM helpers. All text goes through createTextNode → no HTML injection by construction.
export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v !== 'object') throw new Error('style must be an object: the CSP blocks inline style attributes');
        Object.assign(el.style, v);
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') throw new Error('html prop is forbidden');
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...kids) {
  clear(el);
  return append(el, kids);
}

const NS = 'http://www.w3.org/2000/svg';
const P = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  undo: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  'folder-open': 'm6 14 1.5-2.9A2 2 0 0 1 9.2 10H20a2 2 0 0 1 1.9 2.6l-1.6 5.4a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H18a2 2 0 0 1 2 2v2',
  file: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2ZM14 2v6h6',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  terminal: 'm4 17 6-6-6-6M12 19h8',
  send: 'm5 12 7-7 7 7M12 19V5',
  stop: 'M6 6h12v12H6z',
  cog: 'M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  search: 'm21 21-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z',
  refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5',
  copy: 'M9 9h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  paperclip: 'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  'panel-left': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18',
  'panel-right': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 3v18',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  pencil: 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9Z',
  brain: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM12 5v13',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  play: 'm6 3 14 9-14 9Z',
  layers: 'm12 2 10 5-10 5L2 7ZM2 17l10 5 10-5M2 12l10 5 10-5',
  question: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  at: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  circle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  'folder-plus': 'M12 10v6M9 13h6M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  shield: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z',
  map: 'M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.4A1 1 0 0 0 3 7.3v12.2a.5.5 0 0 0 .7.4l4.4-2.2a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.2a1 1 0 0 0 .6-.9V4.5a.5.5 0 0 0-.7-.4l-4.4 2.2a2 2 0 0 1-1.8 0ZM15 6.8v14M9 3.2v14',
  cpu: 'M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 9h6v6H9Z',
  key: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4M21 2l-9.6 9.6M7.5 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-1.8a2 2 0 0 0-1.5 3.3 1.7 1.7 0 0 1-1.3 2.7ZM7.5 10.5h.01M10.5 7.5h.01M15.5 7.5h.01M17.5 11.5h.01',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3Z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  wrap: 'M3 6h18M3 12h15a3 3 0 0 1 0 6h-4M16 16l-2 2 2 2M3 18h7',
};

export function icon(name, size = 16, cls = '') {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', P[name] || P.circle);
  svg.append(p);
  return svg;
}

const svgEl = (tag, attrs, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};

// The mark: two orbits woven into an X inside an O, one cyan node. Geometry matches site/assets/img/logo-static.svg and assets/icon.png.
// The symbols live in index.html (#orbix-mark, and #orbix-mark-s, the simplified master for sizes up to 32 px). The mark is static;
// life comes from CSS on the .logo element, so there is no per-instance geometry and no layout shift.
export function logo(size = 20) {
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', size <= 32 ? '#orbix-mark-s' : '#orbix-mark');
  const svg = svgEl('svg', { class: 'logo', viewBox: '0 0 512 512', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' }, use);
  return svg;
}

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: `ibtn ${cls}`.trim(), title, 'aria-label': title.replace(/\s*\(.*\)$/, ''), onclick, type: 'button' }, icon(name, 16));
}

export const kbd = (k) => h('kbd', null, k);

export function spinner(size = 14) {
  return h('span', { class: 'spin', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' });
}

/** Placeholder lines while something loads. They fade in only after 150 ms, so fast loads never flash. */
export function skeleton(lines = 4, cls = '') {
  return h('div', { class: `skel ${cls}`.trim(), role: 'status', 'aria-label': 'Loading' }, Array.from({ length: lines }, (_, i) => h('i', { class: 'skel-l', style: { width: `${[92, 74, 84, 58, 88, 66][i % 6]}%` } })));
}

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
/**
 * Play the exit animation (class `leaving`, see app.css), then remove the element (or hide it with `hide`).
 * Taking the `leaving` class off before it ends cancels the exit (the element stays).
 */
export function leave(el, { hide = false, then } = {}) {
  if (!el || !el.isConnected || el.classList.contains('leaving')) return;
  const finish = () => {
    if (hide) el.hidden = true;
    else el.remove();
    then?.();
  };
  if (reduced.matches || !el.getClientRects().length) return finish();
  el.classList.add('leaving');
  let fired = false;
  const fin = () => {
    if (fired) return;
    fired = true;
    if (!el.classList.contains('leaving')) return; // cancelled
    el.classList.remove('leaving');
    finish();
  };
  el.addEventListener('animationend', (e) => e.target === el && fin(), { once: true });
  setTimeout(fin, 260);
}

export const fmtTokens = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)));
export const fmtCost = (c) => (c == null ? '–' : c < 0.01 && c > 0 ? '<$0.01' : '$' + c.toFixed(c < 1 ? 3 : 2));
export function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
export function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return 'now';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const baseName = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
export function relPath(p, ws) {
  if (!p || !ws) return p || '';
  const n = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = n(p);
  const b = n(ws);
  const toLinux = (x) => x.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  for (const [x, y] of [[a, b], [toLinux(a), toLinux(b)]]) if (x.toLowerCase().startsWith(y.toLowerCase() + '/')) return x.slice(y.length + 1);
  return p;
}

export function toast(msg, kind = 'info', ms = 4200) {
  const root = $('#toasts');
  if (!root) return;
  // The same message again while it is still shown: restart its timer instead of stacking a copy.
  const same = [...root.children].find((x) => x._msg === msg && x._kind === kind && !x.classList.contains('leaving'));
  if (same) {
    clearTimeout(same._timer);
    same._timer = setTimeout(() => leave(same), ms);
    same.classList.remove('bump');
    void same.offsetWidth;
    same.classList.add('bump');
    return;
  }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info', 15), h('span', null, msg));
  t._msg = msg;
  t._kind = kind;
  t.addEventListener('click', () => leave(t));
  root.append(t);
  t._timer = setTimeout(() => leave(t), ms);
  while (root.children.length > 5) root.firstChild.remove();
}

/** Copy to the clipboard. `quiet` skips the toast (the caller shows its own feedback). Returns true on success. */
export async function copyText(text, { quiet = false } = {}) {
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
  }
  if (!quiet) ok ? toast('Copied', 'ok', 1400) : toast('Copy failed', 'error');
  return ok;
}

/** Briefly swap a button's content for a check mark after a successful copy. */
export async function copyButtonFeedback(btn, text) {
  if (!(await copyText(text, { quiet: true }))) return toast('Copy failed', 'error');
  const kids = [...btn.childNodes];
  btn.replaceChildren(icon('check', 13), btn.dataset.done || 'Copied');
  btn.classList.add('done');
  setTimeout(() => {
    btn.replaceChildren(...kids);
    btn.classList.remove('done');
  }, 1200);
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem('orbix.' + key) ?? localStorage.getItem('omph.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function lsSet(key, value) {
  try {
    localStorage.setItem('orbix.' + key, JSON.stringify(value));
    localStorage.removeItem('omph.' + key);
  } catch {}
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export const rafThrottle = (fn) => {
  let queued = false;
  let last;
  return (...a) => {
    last = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...last);
    });
  };
};

/**
 * A short, plain session title from free text: first sentence, no emoji/markdown/code, no "please / can you"
 * filler, at most `max` characters cut on a word boundary. Same rule on the server and in the UI.
 */
export function makeTitle(text, max = 48) {
  let t = String(text || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[`*_#>]|\[|\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.split(/(?<=[.!?])\s/)[0] || t;
  const whole = t;
  for (let i = 0; i < 6; i++) t = t.replace(/^(please|pls|hey|hi|hello|ok|okay|so|now|can you|could you|would you|will you|i want you to|i need you to|i want to|help me|let's|lets)\b[\s,:;-]*/i, '');
  if (!t.replace(/[\s.!?,:;-]/g, '')) t = whole; // only filler ("hi"): keep it as typed
  t = t.replace(/[\s.!?,:;-]+$/, '');
  if (t.length > max) {
    t = t.slice(0, max);
    const cut = t.lastIndexOf(' ');
    if (cut > max * 0.55) t = t.slice(0, cut);
    t = t.replace(/[\s.,:;-]+$/, '') + '…';
  }
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
