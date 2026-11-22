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
  paperclip: 'm21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5',
  'panel-left': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM9 3v18',
  columns: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM12 3v18',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  minimize: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  'panel-right': 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM15 3v18',
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
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};

// The ORBIX mark (logo kit v2): an O split along one elliptical orbit whose halves swap sides and become `)(`, the X
// in ORBIX. Drawn as the two halves of the O; at rest they sit swapped (the X). One colour, currentColor (Bone on
// dark, Obsidian on light); Plasma only while an agent works.
const HALF_L = 'M0 50C0 22.39 22.39 0 50 0C50.12 0 50.23 0 50.35 0V18C50.23 18 50.12 18 50 18C32.33 18 18 32.33 18 50C18 67.67 32.33 82 50 82C50.12 82 50.23 82 50.35 82V100C50.23 100 50.12 100 50 100C22.39 100 0 77.61 0 50Z';
const HALF_R = 'M49.65 100V82C49.77 82 49.88 82 50 82C67.67 82 82 67.67 82 50C82 32.33 67.67 18 50 18C49.88 18 49.77 18 49.65 18V0C49.77 0 49.88 0 50 0C77.61 0 100 22.39 100 50C100 77.61 77.61 100 50 100C49.88 100 49.77 100 49.65 100Z';
const WORDMARK = 'M227.77 0H245.77V50.65C254.89 42.77 266.77 38 279.77 38C308.49 38 331.77 61.28 331.77 90C331.77 118.72 308.49 142 279.77 142C266.77 142 254.89 137.23 245.77 129.35V140H227.77ZM0 90C0 61.28 23.28 38 52 38C80.72 38 104 61.28 104 90C104 118.72 80.72 142 52 142C23.28 142 0 118.72 0 90ZM382.77 142V124C401.55 124 416.77 108.78 416.77 90C416.77 71.22 401.55 56 382.77 56V38C403.35 38 421.14 49.96 429.57 67.31C438 49.96 455.79 38 476.37 38V56C457.59 56 442.37 71.22 442.37 90C442.37 108.78 457.59 124 476.37 124V142C455.79 142 438 130.04 429.57 112.69C421.14 130.04 403.35 142 382.77 142ZM245.77 90C245.77 108.78 260.99 124 279.77 124C298.55 124 313.77 108.78 313.77 90C313.77 71.22 298.55 56 279.77 56C260.99 56 245.77 71.22 245.77 90ZM18 90C18 108.78 33.22 124 52 124C70.78 124 86 108.78 86 90C86 71.22 70.78 56 52 56C33.22 56 18 71.22 18 90ZM122 40H140V50.65C149.12 42.77 161 38 174 38C188.36 38 201.36 43.82 210.77 53.23L198.04 65.96C191.89 59.81 183.39 56 174 56C155.22 56 140 71.22 140 90V140H122ZM350.77 40H368.77V140H350.77Z';

/**
 * The mark. `alive`: the halves swap O ↔ X on the brand's 2.8 s loop while an agent works (.agent-busy), and
 * `loop` keeps swapping always (the loader). Under reduced motion it holds the X.
 */
export function logo(size = 20, { alive = false, loop = false } = {}) {
  return svgEl('svg', { class: 'logo' + (alive ? ' alive' : '') + (loop ? ' loop' : ''), viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
    svgEl('path', { class: 'lg-h lg-l', fill: 'currentColor', d: HALF_L }),
    svgEl('path', { class: 'lg-h lg-r', fill: 'currentColor', d: HALF_R }));
}

/** The wordmark: "orbix" whose x is the mark; the i's dot is Plasma. `height` in px. */
export function wordmark(height = 13) {
  return svgEl('svg', { class: 'wordmark', viewBox: '0 0 476.37 142', height, width: Math.round((height * 476.37) / 142), role: 'img', 'aria-label': 'ORBIX', focusable: 'false' },
    svgEl('path', { fill: 'currentColor', d: WORDMARK }),
    svgEl('path', { class: 'wm-dot', d: 'M350.77 0H368.77V18H350.77V0Z' }));
}

/** The mark in its tile: the app icon's shape, and the only way the mark sits beside the name. */
export function logoTile(size = 44) {
  return h('span', { class: 'logo-tile', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' }, logo(size));
}

// ================= The hero: the mark, made of light =================
// Home and an empty conversation. The mark is sampled into particles (one per ~1.3 px of its two halves). They come
// in as a flat Plasma galaxy that spirals into the O, the halves swap along the brand's arc (the far one smaller and
// dimmer) into the X, and the mark snaps with a shock ring. Then it is matter: the pointer parts it, a click scatters
// it and springs pull it back; a Plasma sheen sweeps across every 7 s (2.4 s while an agent works). At rest the exact
// vector mark is drawn over the particles, so it stays crisp, and the loop sleeps until the next sweep or the pointer
// comes near: no frames are drawn while nothing moves, and none while it is off screen or the window is hidden.
// Reduced motion draws the still X.
const ease3 = (t) => 1 - (1 - t) ** 3;
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
function toRGB(s, fb) {
  s = (s || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) { const p = m[1].split(/[\s,/]+/).map(Number); if (p.length >= 3 && p.every((v, i) => i > 2 || Number.isFinite(v))) return p.slice(0, 3); }
  return fb;
}

const INTRO_GATHER = 1300, INTRO_SPREAD = 450, SWAP_AT = 1950, SWAP_MS = 850, SWEEP_MS = 1100;

/** The large mark for Home and an empty conversation. `size` is the mark's height in px; the canvas is 3× as wide. */
export function heroMark(size = 72) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx || typeof Path2D !== 'function') return { el: logo(size), destroy() {} };
  canvas.className = 'hero-mark';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.setProperty('--hw', Math.round(size * 3) + 'px');
  const root = document.documentElement;
  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const motionOff = () => rm.matches || root.classList.contains('sr') || root.dataset.motion === 'off';

  // Sample the halves of the O in mark units (0…100); the X puts the left half 45 to the right and the right half 45
  // to the left.
  const halves = [new Path2D(HALF_L), new Path2D(HALF_R)];
  const su = (Math.max(1.25, size / 56) * 100) / size;
  const pts = [];
  for (let s = 0; s < 2; s++) for (let y = su / 2; y < 100; y += su) for (let x = su / 2; x < 100; x += su) if (ctx.isPointInPath(halves[s], x, y)) pts.push(s, x, y);
  const N = pts.length / 3;
  const F = () => new Float32Array(N);
  const side = new Uint8Array(N), hx = F(), hy = F(), tx = F(), ty = F(), x = F(), y = F(), vx = F(), vy = F(), heat = F(), al = F(), rh = F(), ah = F(), r0 = F(), spin = F(), delay = F(), dsp = F();
  for (let i = 0; i < N; i++) {
    side[i] = pts[3 * i]; hx[i] = pts[3 * i + 1]; hy[i] = pts[3 * i + 2];
    tx[i] = hx[i] + (side[i] ? -45 : 45); ty[i] = hy[i];
    rh[i] = Math.hypot(hx[i] - 50, hy[i] - 50); ah[i] = Math.atan2(hy[i] - 50, hx[i] - 50);
    r0[i] = 70 + Math.random() * 80; spin[i] = 2.6 + Math.random() * 2.2; delay[i] = Math.random() ** 1.5 * INTRO_SPREAD;
    x[i] = tx[i]; y[i] = ty[i]; al[i] = 1;
  }
  // Particles are drawn in buckets of colour (6 steps Bone → Plasma) × alpha (4 steps), so a frame sets ~20 styles.
  const HQ = 6, AQ = 5, lists = Array.from({ length: HQ * AQ }, () => new Uint16Array(N)), counts = new Uint16Array(HQ * AQ);
  let styles = [], markRGB = [244, 244, 240], plasma = [255, 46, 126], dark = true, markFill = '#F4F4F0';
  function setColors() {
    const cs = getComputedStyle(root);
    markRGB = toRGB(cs.getPropertyValue('--mark'), markRGB);
    plasma = toRGB(cs.getPropertyValue('--plasma'), plasma);
    dark = (0.2126 * markRGB[0] + 0.7152 * markRGB[1] + 0.0722 * markRGB[2]) / 255 > 0.5;
    markFill = `rgb(${markRGB.join(',')})`;
    styles = [];
    for (let q = 0; q < HQ; q++) for (let a = 0; a < AQ; a++) {
      const t = q / (HQ - 1), c = markRGB.map((v, j) => Math.round(v + (plasma[j] - v) * t));
      styles.push(`rgba(${c.join(',')},${a / (AQ - 1)})`);
    }
  }

  let cw = 0, ch = 0, dpr = 1, raf = 0, timer = 0, last = 0, clock = 0, phase = 0, solid = 0, glow = 0, settled = false;
  let visible = false, stopped = false, still = motionOff(), busy = root.classList.contains('agent-busy');
  let nextSweep = 0, sweepT0 = -1, ptr = null, rect = null;
  const rings = [];
  const toUnits = (cx, cy) => { const k = rect.width / 300; return { x: (cx - rect.left - rect.width / 2) / k + 50, y: (cy - rect.top - rect.height / 2) / k + 50 }; };

  function toStill() {
    phase = 1; solid = 1; glow = 0.55; rings.length = 0;
    for (let i = 0; i < N; i++) { x[i] = tx[i]; y[i] = ty[i]; vx[i] = vy[i] = heat[i] = dsp[i] = 0; al[i] = 1; }
  }

  function intro() {
    const t = clock;
    for (let i = 0; i < N; i++) {
      let px, py, a = 1, h = 0;
      if (t < SWAP_AT) {
        // A flat galaxy spiralling in: radius and spin unwind, the disc tilts up into the mark's plane.
        const e = clamp01((t - delay[i]) / INTRO_GATHER), ee = ease3(e);
        const r = rh[i] + (r0[i] - rh[i]) * (1 - ee), an = ah[i] + spin[i] * (1 - ee), sn = Math.sin(an);
        px = 50 + r * Math.cos(an); py = 50 + r * sn * (0.3 + 0.7 * ee);
        a = Math.min(1, e * 2.2) * (1 - 0.5 * (1 - ee) * (sn < 0 ? -sn : 0));
        h = (1 - ee) ** 1.5 * 0.95;
      } else {
        // O → X along the brand's arc: the right half dips behind (smaller, dimmer), the left passes in front.
        const u = easeIO(clamp01((t - SWAP_AT) / SWAP_MS)), b = Math.sin(Math.PI * u);
        const L = side[i] === 0, c0 = L ? 25.2 : 74.8, sc = L ? 1 + 0.04 * b : 1 - 0.1 * b;
        px = c0 + (hx[i] - c0) * sc + (L ? 45 : -45) * u; py = 50 + (hy[i] - 50) * sc + (L ? 7.65 : -7.65) * b;
        if (!L) a = 1 - 0.45 * b;
        h = 0.3 * b;
      }
      x[i] = px; y[i] = py; al[i] = a; heat[i] = h;
    }
    glow = Math.min(1, t / SWAP_AT) * 0.55;
    if (t >= SWAP_AT + SWAP_MS) {
      // The snap: everything lands, gets a small outward kick and wobbles in; a shock ring leaves the centre.
      phase = 1;
      for (let i = 0; i < N; i++) {
        x[i] = tx[i]; y[i] = ty[i]; al[i] = 1;
        const dx = tx[i] - 50, dy = ty[i] - 50, d = Math.hypot(dx, dy) || 1;
        vx[i] = (dx / d) * 0.9; vy[i] = (dy / d) * 0.9;
      }
      rings.push({ x: 50, y: 50, t: 0, dur: 900, r0: 30, r1: 140 }, { x: 50, y: 50, t: -140, dur: 900, r0: 20, r1: 105 });
      glow = 1.6;
      nextSweep = clock + 3200;
    }
  }

  function live(f, pu) {
    let sweepPos = null;
    if (sweepT0 < 0 && clock >= nextSweep) sweepT0 = clock;
    if (sweepT0 >= 0) {
      const p = (clock - sweepT0) / SWEEP_MS;
      if (p >= 1) { sweepT0 = -1; nextSweep = clock + (busy ? 2400 : 7000); } else sweepPos = -25 + 190 * easeIO(p);
    }
    const damp = Math.pow(0.86, f), K = 0.05 * f, R = 30, R2 = R * R, cool = Math.pow(0.93, f);
    let maxV = 0, maxD = 0, maxH = 0;
    for (let i = 0; i < N; i++) {
      let ax = (tx[i] - x[i]) * K, ay = (ty[i] - y[i]) * K;
      if (pu) {
        const dx = x[i] - pu.x, dy = y[i] - pu.y, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 1e-4) { const d = Math.sqrt(d2), g = 1 - d / R, fo = g * g * 1.8 * f; ax += (dx / d) * fo; ay += (dy / d) * fo; }
      }
      vx[i] = (vx[i] + ax) * damp; vy[i] = (vy[i] + ay) * damp;
      x[i] += vx[i] * f; y[i] += vy[i] * f;
      const sp = Math.abs(vx[i]) + Math.abs(vy[i]), d = Math.abs(x[i] - tx[i]) + Math.abs(y[i] - ty[i]);
      let h = Math.max(heat[i] * cool, Math.min(1, sp * 0.45));
      if (sweepPos !== null) { const g = 1 - Math.abs(x[i] + 0.45 * y[i] - sweepPos) / 12; if (g > 0) h = Math.max(h, g * 0.85); }
      heat[i] = h; dsp[i] = d;
      if (sp > maxV) maxV = sp; if (d > maxD) maxD = d; if (h > maxH) maxH = h;
    }
    const target = maxD < 0.12 ? 1 : 0;
    solid = clamp01(solid + (target - solid) * (target ? 0.08 : 0.35) * f);
    if (target && solid > 0.995) solid = 1;
    const base = busy ? 0.8 : 0.55;
    glow += (base - glow) * Math.min(1, 0.04 * f);
    for (let j = rings.length - 1; j >= 0; j--) if ((rings[j].t += f * 16.667) >= rings[j].dur) rings.splice(j, 1);
    settled = !pu && sweepPos === null && !rings.length && maxV < 0.003 && maxD < 0.03 && maxH < 0.02 && solid === 1 && Math.abs(glow - base) < 0.01;
    if (settled) { glow = base; for (let i = 0; i < N; i++) { x[i] = tx[i]; y[i] = ty[i]; vx[i] = vy[i] = heat[i] = dsp[i] = 0; } }
  }

  function draw() {
    if (!cw || !ch) return;
    const k = cw / 300, ox = cw / 2 - 50 * k, oy = ch / 2 - 50 * k, P = plasma.join(',');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cw, ch);
    if (dark && glow > 0.01) {
      const g = ctx.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, 95 * k);
      g.addColorStop(0, `rgba(${P},${Math.min(0.2, 0.085 * glow)})`);
      g.addColorStop(1, `rgba(${P},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
    }
    ctx.lineWidth = 1.2;
    for (const r of rings) {
      if (r.t < 0) continue;
      const p = r.t / r.dur, rad = (r.r0 + (r.r1 - r.r0) * ease3(p)) * k;
      ctx.strokeStyle = `rgba(${P},${0.6 * (1 - p) ** 2})`;
      ctx.beginPath();
      ctx.ellipse(ox + r.x * k, oy + r.y * k, rad, rad * 0.36, -0.17, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (solid > 0) {
      ctx.save();
      ctx.globalAlpha = solid;
      ctx.fillStyle = markFill;
      ctx.translate(ox, oy); ctx.scale(k, k);
      ctx.translate(45, 0); ctx.fill(halves[0]);
      ctx.translate(-90, 0); ctx.fill(halves[1]);
      ctx.restore();
    }
    counts.fill(0);
    for (let i = 0; i < N; i++) {
      const h = heat[i];
      let a = al[i];
      if (solid > 0 && h < 0.04 && dsp[i] < 0.25) a *= 1 - solid; // the vector mark already shows a resting particle
      const aq = Math.min(AQ - 1, Math.round(a * (AQ - 1)));
      if (!aq) continue;
      const b = Math.min(HQ - 1, Math.round(h * (HQ - 1))) * AQ + aq;
      lists[b][counts[b]++] = i;
    }
    const ds = su * k * 1.12, hs = ds / 2;
    for (let b = 0; b < HQ * AQ; b++) {
      const n = counts[b], L = lists[b];
      if (!n) continue;
      ctx.fillStyle = styles[b];
      for (let j = 0; j < n; j++) { const i = L[j]; ctx.fillRect(ox + x[i] * k - hs, oy + y[i] * k - hs, ds, ds); }
    }
    if (dark) {
      // Bloom on the hottest particles.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = `rgb(${P})`;
      const bs = ds * 2.8, bh = bs / 2;
      for (let q = 3; q < HQ; q++) for (let aq = 2; aq < AQ; aq++) {
        const b = q * AQ + aq, L = lists[b];
        for (let j = 0; j < counts[b]; j++) { const i = L[j]; ctx.fillRect(ox + x[i] * k - bh, oy + y[i] * k - bh, bs, bs); }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  }

  const alive = () => !stopped && visible && !document.hidden && canvas.isConnected;
  function frame(now) {
    raf = 0;
    if (!alive()) return;
    if (motionOff()) { still = true; toStill(); draw(); return; }
    // Physics steps at most 50 ms; the clock keeps real time once the mark is live, so a sleep still ends in a sweep.
    const raw = last ? now - last : 16.667, dt = Math.min(50, raw), f = dt / 16.667;
    last = now;
    clock += phase === 1 ? raw : dt;
    rect = canvas.getBoundingClientRect();
    let pu = null;
    if (ptr && rect.width) {
      const u = toUnits(ptr.x, ptr.y);
      if (u.x > -40 && u.x < 140 && u.y > -40 && u.y < 140) pu = u;
    }
    settled = false;
    if (phase === 0) intro(); else live(f, pu);
    draw();
    if (phase === 1 && settled) timer = setTimeout(wake, Math.max(50, nextSweep - clock));
    else raf = requestAnimationFrame(frame);
  }
  function wake() {
    if (raf || stopped) return;
    if (still) { draw(); return; }
    clearTimeout(timer); timer = 0;
    raf = requestAnimationFrame(frame);
  }

  // The pointer wakes the mark when it comes near; it parts the particles while over it, a press scatters them.
  const near = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    return r.width && cx > r.left - 40 && cx < r.right + 40 && cy > r.top - 40 && cy < r.bottom + 40;
  };
  const onMove = (e) => {
    if (still || phase === 0) return;
    if (e.pointerType === 'touch') return;
    if (!near(e.clientX, e.clientY)) { if (ptr) { ptr = null; wake(); } return; }
    ptr = { x: e.clientX, y: e.clientY };
    wake();
  };
  const onLeave = () => { if (ptr) { ptr = null; wake(); } };
  const onDown = (e) => {
    if (still || phase === 0 || e.button > 0) return;
    rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const p = toUnits(e.clientX, e.clientY);
    // Only a press on the mark itself (its X spans 5…95 across, 0…100 down).
    if (p.x < 2 || p.x > 98 || p.y < -2 || p.y > 102) return;
    for (let i = 0; i < N; i++) {
      const dx = x[i] - p.x, dy = y[i] - p.y, d = Math.hypot(dx, dy) || 1, s = 7 / (1 + d / 22);
      vx[i] += (dx / d) * s + (Math.random() - 0.5) * 1.2; vy[i] += (dy / d) * s + (Math.random() - 0.5) * 1.2;
      heat[i] = 1;
    }
    rings.push({ x: p.x, y: p.y, t: 0, dur: 800, r0: 6, r1: 90 });
    glow = 1.8;
    wake();
  };

  setColors();
  if (still) toStill();
  const ro = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    cw = r.width; ch = r.height; dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cw * dpr)); canvas.height = Math.max(1, Math.round(ch * dpr));
    draw();
    wake();
  });
  ro.observe(canvas);
  const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) wake(); });
  io.observe(canvas);
  const mo = new MutationObserver(() => {
    const b = root.classList.contains('agent-busy');
    if (b && !busy) nextSweep = Math.min(nextSweep, clock + 300);
    busy = b;
    setColors();
    if (motionOff() && !still) { still = true; toStill(); }
    draw();
    wake();
  });
  mo.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-mode', 'data-scene', 'data-theme', 'data-motion'] });
  const onVis = () => { if (!document.hidden) { last = 0; wake(); } };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onDown, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);
  return {
    el: canvas,
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf); clearTimeout(timer); raf = timer = 0;
      ro.disconnect(); io.disconnect(); mo.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
    },
  };
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
