// Tiny DOM helpers. All text goes through createTextNode → no HTML injection by construction.
import { tileIndex, tileLetter } from './tile.mjs';
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

function append(el, kids) {
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
  bookmark: 'M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z',
  plus: 'M12 5v14M5 12h14',
  'thumb-up': 'M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
  'thumb-down': 'M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
  minus: 'M5 12h14',
  undo: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm18 15-6-6-6 6',
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
  play: 'M7 4v16l13-8Z',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
  copy: 'M9 9h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  filter: 'M4 7h16M7 12h10M10 17h4',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  user: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  paperclip: 'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  'panel-left': 'M6 5h12a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5H6a3.5 3.5 0 0 1-3.5-3.5v-7A3.5 3.5 0 0 1 6 5ZM9 5v14',
  columns: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM12 3v18',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  'panel-right': 'M6 5h12a3.5 3.5 0 0 1 3.5 3.5v7a3.5 3.5 0 0 1-3.5 3.5H6a3.5 3.5 0 0 1-3.5-3.5v-7A3.5 3.5 0 0 1 6 5ZM15 5v14',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  pencil: 'M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  command: 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'arrow-right': 'M5 12h14M12 5l7 7-7 7',
  'more-v': 'M12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  star: 'M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.3L12 17.1l-5.6 3 1.1-6.3L2.9 9.4l6.3-.9Z',
  sparkle: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9ZM19 3v4M17 5h4',
  archive: 'M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  'git-fork': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 9a9 9 0 0 1-9 9',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3ZM21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5',
  puzzle: 'M15.4 4.6a2 2 0 1 0-3.4-1.4V5H8a1 1 0 0 0-1 1v4H5.2a2 2 0 1 0 0 4H7v4a1 1 0 0 0 1 1h4v-1.8a2 2 0 1 1 4 0V19h3a1 1 0 0 0 1-1v-4h-1.8a2 2 0 1 1 0-4H20V6a1 1 0 0 0-1-1h-3v-.4Z',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9Z',
  infinity: 'M12 12c-2-2.7-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.3 6-4Zm0 0c2 2.7 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.3-6 4Z',
  brain: 'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18ZM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18ZM12 5v13',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z',
  cloud: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  server: 'M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 13h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1ZM7 7h.01M7 17h.01',
  smartphone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM12 18h.01',
  incognito: 'M2 11h20M5 11l2-7h10l2 7M7 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM17 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10 15h4',
  laptop: 'M4 5h16a1 1 0 0 1 1 1v10H3V6a1 1 0 0 1 1-1ZM1 19h22',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  layers: 'm12 2 10 5-10 5L2 7ZM2 17l10 5 10-5M2 12l10 5 10-5',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  at: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  circle: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
  gauge: 'M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0',
  'folder-plus': 'M12 10v6M9 13h6M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM7 11V7a5 5 0 0 1 10 0v4',
  'shield-check': 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1ZM9 12l2 2 4-4',
  'shield-off': 'M2 2l20 20M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.7 9a1 1 0 0 0 .7 0 13 13 0 0 0 4-2.4M9.3 3.6c.6-.4 1.3-.8 1.9-1.3a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1v7a9 9 0 0 1-.3 2.5',
  shield: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z',
  map: 'M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.4A1 1 0 0 0 3 7.3v12.2a.5.5 0 0 0 .7.4l4.4-2.2a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.2a1 1 0 0 0 .6-.9V4.5a.5.5 0 0 0-.7-.4l-4.4 2.2a2 2 0 0 1-1.8 0ZM15 6.8v14M9 3.2v14',
  cpu: 'M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 9h6v6H9Z',
  key: 'm15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4M21 2l-9.6 9.6M7.5 21a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-1.8a2 2 0 0 0-1.5 3.3 1.7 1.7 0 0 1-1.3 2.7ZM7.5 10.5h.01M10.5 7.5h.01M15.5 7.5h.01M17.5 11.5h.01',
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3Z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
  keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2ZM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  wrap: 'M3 6h18M3 12h15a3 3 0 0 1 0 6h-4M16 16l-2 2 2 2M3 18h7',
  download: 'M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5',
};

// The pane of the panel icons: filled while that panel is open (its button has .on), as a window frame with the side
// shaded in; otherwise only the frame and its divider show.
const PANE = {
  'panel-left': 'M9 5H6a3.5 3.5 0 0 0-3.5 3.5v7A3.5 3.5 0 0 0 6 19h3Z',
  'panel-right': 'M15 5h3a3.5 3.5 0 0 1 3.5 3.5v7A3.5 3.5 0 0 1 18 19h-3Z',
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
  if (PANE[name]) {
    const pane = document.createElementNS(NS, 'path');
    pane.setAttribute('class', 'ic-pane');
    pane.setAttribute('d', PANE[name]);
    svg.append(pane);
  }
  svg.append(p);
  return svg;
}

const svgEl = (tag, attrs, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};

// The ORBIX mark (logo kit v2): an O split along one elliptical orbit whose halves swap sides and become `)(`, the X
// in ORBIX. Drawn as the two halves of the O; at rest they sit swapped (the X). One colour, currentColor (Bone on
// dark, Obsidian on light); the brand green only while an agent works.
const HALF_L = 'M0 50C0 22.39 22.39 0 50 0C50.12 0 50.23 0 50.35 0V18C50.23 18 50.12 18 50 18C32.33 18 18 32.33 18 50C18 67.67 32.33 82 50 82C50.12 82 50.23 82 50.35 82V100C50.23 100 50.12 100 50 100C22.39 100 0 77.61 0 50Z';
const HALF_R = 'M49.65 100V82C49.77 82 49.88 82 50 82C67.67 82 82 67.67 82 50C82 32.33 67.67 18 50 18C49.88 18 49.77 18 49.65 18V0C49.77 0 49.88 0 50 0C77.61 0 100 22.39 100 50C100 77.61 77.61 100 50 100C49.88 100 49.77 100 49.65 100Z';

/**
 * The mark. `alive`: the halves swap O ↔ X on the brand's 2.8 s loop while an agent works (.agent-busy), and
 * `loop` keeps swapping always (the loader). Under reduced motion it holds the X.
 */
export function logo(size = 20, { alive = false, loop = false } = {}) {
  return svgEl('svg', { class: 'logo' + (alive ? ' alive' : '') + (loop ? ' loop' : ''), viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    svgEl('path', { class: 'lg-h lg-l', fill: 'currentColor', d: HALF_L }),
    svgEl('path', { class: 'lg-h lg-r', fill: 'currentColor', d: HALF_R }));
}

/**
 * ORBIX in block letters drawn with ASCII characters and animated, the way a terminal draws a logo. Each pixel of the
 * letters is a 2×2 patch of characters on a canvas. On arrival the characters scramble and settle into the letters
 * from left to right; at rest a glint sweeps across every few seconds, thinning the characters it passes
 * (@ → # → * → + → . and back). The X is in the brand colour; while an agent works it takes the live colour and the
 * glint keeps running. Near the pointer the characters heat up: they scramble, turn the brand colour and cool back
 * into the letters after it passes. Reduced motion shows the settled letters, still.
 */
const WORD = [
  ['####', '#..#', '#..#', '#..#', '####'],
  ['####', '#..#', '####', '#.#.', '#..#'],
  ['###.', '#..#', '####', '#..#', '####'],
  ['###', '.#.', '.#.', '.#.', '###'],
  ['#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
];
const RAMP = '@%#*+=-:. '; // dense to empty
const NOISE = '!#$%&*+=?@0123456789<>/\\|{}[]~^';
const SUB = 2; // characters per letter pixel, each way
const CELL_W = 6, CELL_H = 7, FONT = 10; // px per character cell
const WORD_CELLS = (() => {
  const cells = [];
  let x0 = 0;
  WORD.forEach((rows, li) => {
    const w = rows[0].length;
    rows.forEach((row, y) => [...row].forEach((v, x) => {
      const inner = li < 3 && x > 0 && x < w - 1 && y > 0 && y < rows.length - 1;
      if (v !== '#' && !inner) return;
      for (let sy = 0; sy < SUB; sy++) for (let sx = 0; sx < SUB; sx++) {
        const cx = (x0 + x) * SUB + sx, cy = y * SUB + sy;
        // Ink cells get a dense character from a soft light from the top left; counters a faint dot.
        const shade = v === '#' ? Math.min(3, Math.floor(((cx / 48) * 0.6 + (cy / 10) * 0.4) * 4)) : -1;
        cells.push({ cx, cy, kind: v === '#' ? (li === 4 ? 'x' : 'ink') : 'fill', rest: shade < 0 ? '.' : RAMP[shade] });
      }
    }));
    x0 += w + 1;
  });
  return { cells, cols: x0 * SUB - SUB, rows: WORD[0].length * SUB };
})();

export function wordmark() {
  const { cells, cols, rows } = WORD_CELLS;
  const W = cols * CELL_W, H = rows * CELL_H;
  const cv = h('canvas', { class: 'wordmark', role: 'img', 'aria-label': 'ORBIX', style: { width: W + 'px', height: H + 'px' } });
  const ctx = cv.getContext('2d');
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('no-motion');
  const pick = (s) => s[(Math.random() * s.length) | 0];
  let born = 0, glint = -1, raf = 0, wait = 0, dpr = 0;
  // The cursor: characters near the pointer heat up (they scramble and turn the brand colour) and cool down after it.
  const R = 52; // px
  const heat = new Float32Array(cells.length);
  const glyph = cells.map((c) => c.rest);
  const ptr = { x: -1e4, y: -1e4 };

  function draw(now) {
    const ratio = Math.min(devicePixelRatio || 1, 3);
    if (ratio !== dpr) { dpr = ratio; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const css = getComputedStyle(cv);
    const busy = !!cv.closest('.agent-busy');
    const col = { ink: css.getPropertyValue('--mark').trim() || '#F4F4F0', x: css.getPropertyValue(busy ? '--plasma' : '--accent').trim() || '#3DF28C', fill: css.getPropertyValue('--fg-3').trim() || '#777' };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `600 ${FONT}px ${css.getPropertyValue('--mono').trim() || 'monospace'}`;
    ctx.textBaseline = 'top';
    const t = still() ? Infinity : now - born;
    let hot = false;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      // Arrival: a scramble that settles left to right over ~0.9 s.
      const settle = 260 + (c.cx / cols) * 640 + (c.cy % 2) * 40;
      let ch = c.rest, alpha = c.kind === 'fill' ? 0.35 : 1;
      if (t < settle) { ch = pick(NOISE); alpha *= Math.min(1, 0.25 + t / settle); }
      else if (glint >= 0 && c.kind !== 'fill') {
        // The glint: a diagonal band that thins the characters it crosses.
        const d = Math.abs(c.cx + c.cy * 0.6 - glint);
        if (d < 5) ch = RAMP[Math.min(RAMP.length - 2, Math.max(0, RAMP.indexOf(c.rest)) + 5 - Math.round(d))];
      }
      let color = col[c.kind];
      if (t >= settle) {
        const d = Math.hypot(c.cx * CELL_W + CELL_W / 2 - ptr.x, c.cy * CELL_H + CELL_H / 2 - ptr.y);
        heat[i] = Math.max(d < R ? (1 - d / R) ** 1.4 : 0, heat[i] * 0.9);
        const k = heat[i];
        if (k > 0.04) {
          hot = true;
          if (k > 0.45) { if (glyph[i] === c.rest || Math.random() < 0.3) glyph[i] = pick(NOISE); ch = glyph[i]; }
          else { glyph[i] = c.rest; ch = c.kind === 'fill' ? '+' : RAMP[Math.min(RAMP.length - 2, Math.max(0, RAMP.indexOf(c.rest)) + Math.round(k * 6))]; }
          if (k > 0.25) color = c.kind === 'x' ? col.ink : col.x;
          alpha = Math.max(alpha, Math.min(1, 0.35 + k));
        } else glyph[i] = c.rest;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillText(ch, c.cx * CELL_W, c.cy * CELL_H);
    }
    ctx.globalAlpha = 1;
    return hot;
  }

  function loop(now) {
    raf = 0;
    if (!cv.isConnected) return;
    if (glint >= 0) { glint += 1.1; if (glint > cols + rows + 8) glint = -1; }
    const hot = draw(now);
    const busy = !!cv.closest('.agent-busy');
    if (still()) return;
    if (now - born < 1000 || glint >= 0 || hot) raf = requestAnimationFrame(loop);
    else { clearTimeout(wait); wait = setTimeout(() => { glint = -6; if (!raf) raf = requestAnimationFrame(loop); }, busy ? 400 : 4200 + Math.random() * 1800); }
  }

  // Follow the pointer anywhere near the letters (the whole window listens, so the effect starts before it is over them).
  const onMove = (e) => {
    if (!cv.isConnected) return removeEventListener('pointermove', onMove);
    if (still() || !born) return;
    const r = cv.getBoundingClientRect();
    ptr.x = e.clientX - r.left;
    ptr.y = e.clientY - r.top;
    const near = ptr.x > -R && ptr.y > -R && ptr.x < r.width + R && ptr.y < r.height + R;
    if (near && !raf) raf = requestAnimationFrame(loop);
  };
  addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', () => { ptr.x = ptr.y = -1e4; });

  // Start once it is on screen and the monospace font is ready, so the first frame is already in the right font.
  const start = () => {
    if (!cv.isConnected) return requestAnimationFrame(start);
    (document.fonts?.ready || Promise.resolve()).then(() => { born = performance.now(); if (!raf) raf = requestAnimationFrame(loop); });
  };
  requestAnimationFrame(start);
  // A theme or palette change repaints it in the new colours (the canvas does not follow CSS on its own).
  const mo = new MutationObserver(() => {
    if (!cv.isConnected) return mo.disconnect();
    if (raf) return;
    draw(performance.now());
    // An agent started: the glint runs now instead of after the idle pause.
    if (born && !still() && cv.closest('.agent-busy') && glint < 0) { clearTimeout(wait); glint = -6; raf = requestAnimationFrame(loop); }
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-mode', 'data-theme', 'data-palette'] });
  return cv;
}

/** The mark in its tile: the app icon's shape (About). */
export function logoTile(size = 44) {
  return h('span', { class: 'logo-tile', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' }, logo(size));
}

/**
 * A working session's mark: a 3×3 grid of dots where light runs round the ring, an orbit in pixels (the sidebar's
 * running rows). Reduced motion shows it still.
 */
const RING = [0, 1, 2, 7, -1, 3, 6, 5, 4]; // each cell's place on the ring, clockwise from the top left (-1: the centre)
export function dotGrid(cls = '') {
  return h('span', { class: `dgrid ${cls}`.trim(), role: 'img', 'aria-label': 'Working' }, RING.map((r) => {
    const d = h('i', r < 0 ? { class: 'c' } : null);
    if (r >= 0) d.style.setProperty('--r', r);
    return d;
  }));
}

/** A project's letter tile: the first letter or digit of its name on a quiet square (the sidebar, the toolbar). */
/** A project's tile: its first letter on its own colour (js/tile.mjs), the same in the sidebar, the rail and the toolbar. */
export function projTile(name, size = 18, cls = '') {
  const el = h('span', { class: `ptile ${cls}`.trim(), 'aria-hidden': 'true', dataset: { tile: String(tileIndex(name)) } }, tileLetter(name));
  el.style.setProperty('--s', `${size}px`);
  return el;
}

/** A shortcut as one quiet text hint, "Ctrl+Alt+R", the same everywhere it is shown. Nothing when there is none. */
export const keyHint = (combo, cls = '') => (combo ? h('span', { class: `khint num${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' }, combo) : null);

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: `ibtn ${cls}`.trim(), 'data-tooltip':title, 'aria-label': title.replace(/\s*\(.*\)$/, ''), onclick, type: 'button' }, icon(name, 16));
}

export const kbd = (k) => h('kbd', null, k);

/**
 * Run `fn` on a plain Enter in `el` (not Shift+Enter, not while an IME is composing). The Enter is consumed, so it
 * cannot also press the button that gets the focus when `fn` closes a dialog or redraws.
 */
export function onEnter(el, fn) {
  el?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    fn(e);
  });
  return el;
}

export function spinner(size = 14) {
  return h('span', { class: 'spin', style: { width: size + 'px', height: size + 'px', fontSize: size + 1 + 'px' }, 'aria-hidden': 'true' });
}

/** Placeholder lines while something loads. They fade in only after 150 ms, so fast loads never flash. */
export function skeleton(lines = 4, cls = '') {
  return h('div', { class: `skel ${cls}`.trim(), role: 'status', 'aria-label': 'Loading' }, Array.from({ length: lines }, (_, i) => h('i', { class: 'skel-l', style: { width: `${[92, 74, 84, 58, 88, 66][i % 6]}%` } })));
}

/**
 * Something that can take more than a moment: a plain label over placeholder lines. Like skeleton(), it shows only
 * after 150 ms, so fast loads never flash.
 */
export function loadingState(label, lines = 3) {
  return h('div', { class: 'loading-state', role: 'status' },
    h('div', { class: 'loading-l' }, spinner(12), h('span', null, label)),
    h('div', { class: 'skel', 'aria-hidden': 'true' }, Array.from({ length: lines }, (_, i) => h('i', { class: 'skel-l', style: { width: `${[88, 64, 76, 52][i % 4]}%` } }))));
}

/**
 * The one error state: what failed, why, an optional hint, and Retry when it can be tried again. `retry` may return a
 * promise (the button waits for it); `action` is an optional second button, { label, run }.
 */
export function errorState(message, { title, hint, retry, retryLabel = 'Retry', action, cls = '' } = {}) {
  const acts = [];
  if (retry) {
    const b = h('button', { class: 'btn sm err-retry', type: 'button' }, retryLabel);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await retry();
      } finally {
        b.disabled = false;
      }
    });
    acts.push(b);
  }
  if (action) acts.push(h('button', { class: 'btn sm ghost', type: 'button', onclick: action.run }, action.label));
  return h('div', { class: `errbox ${cls}`.trim(), role: 'alert' }, icon('alert', 14),
    h('div', { class: 'err-main' },
      title ? h('strong', { class: 'err-title' }, title) : null,
      message ? h('span', { class: 'err-msg' }, String(message)) : null,
      hint ? h('span', { class: 'err-hint' }, hint) : null,
      acts.length ? h('div', { class: 'err-acts' }, acts) : null));
}

const motionOff = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = { get matches() { return motionOff.matches || document.documentElement.classList.contains('sr'); } }; // or Screen reader mode
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
  el._leaveCancel?.();
  el.classList.add('leaving');
  let fired = false;
  let timer;
  const cleanup = () => {
    fired = true;
    clearTimeout(timer);
    el.removeEventListener('animationend', onEnd);
    el.removeEventListener('animationcancel', onCancel);
    delete el._leaveCancel;
  };
  const fin = () => {
    if (fired) return;
    cleanup();
    if (!el.classList.contains('leaving')) return; // cancelled
    el.classList.remove('leaving');
    finish();
  };
  const onEnd = (e) => { if (e.target === el) fin(); };
  const onCancel = (e) => {
    if (e.target === el && !el.classList.contains('leaving')) cleanup();
  };
  el._leaveCancel = cleanup;
  el.addEventListener('animationend', onEnd);
  el.addEventListener('animationcancel', onCancel);
  timer = setTimeout(fin, 260);
}

export const fmtTokens = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n)));
export const fmtCost = (c) => (c == null ? '–' : c < 0.01 && c > 0 ? '<$0.01' : '$' + c.toFixed(c < 1 ? 3 : 2));
/** Whole seconds as 45s or 3m 07s (a running timer). */
export const fmtElapsed = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
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
  return t;
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
  let id = 0;
  const run = (...a) => {
    last = a;
    if (queued) return;
    queued = true;
    id = requestAnimationFrame(() => {
      queued = false;
      id = 0;
      fn(...last);
    });
  };
  run.cancel = () => {
    if (id) cancelAnimationFrame(id);
    queued = false;
    id = 0;
  };
  return run;
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
