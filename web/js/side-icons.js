// The sidebar's own icons: drawn for this place, on one 24px grid with a 1.6px stroke, each with a soft filled
// shape behind its outline (duotone). The fill is the outline's colour at low strength, so the icon reads as one
// object; the current page's icon takes the accent and a stronger fill.
const NS = 'http://www.w3.org/2000/svg';

// [fill shape, outline]
const G = {
  new: ['M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M12 8v8M8 12h8M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z', 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4.6-4.6'],
  customizations: ['M5.5 3.5h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z', 'M5.5 3.5h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2ZM5.5 12.5h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2ZM14.5 12.5h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2ZM16.5 3v7M13 6.5h7'],
  skills: ['M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7Z', 'M10 3.5l1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7ZM18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z'],
  automations: ['M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4.5h-4.5M12 8v4l2.5 2.5'],
  runs: ['M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM10 9l5 3-5 3Z'],
  review: ['M3.5 13.5h4.2l1.6 2.5h5.4l1.6-2.5h4.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z', 'M3.5 13.5 6 5.5a2 2 0 0 1 1.9-1.5h8.2A2 2 0 0 1 18 5.5l2.5 8M3.5 13.5h4.2l1.6 2.5h5.4l1.6-2.5h4.2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2ZM9 9.5l2 2 4-4'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
};

/** A sidebar icon by page name (`new`, `search`, a hub view such as `runs`, `settings`). */
export function sideIcon(name, size = 18) {
  const [fill, line] = G[name] || G.new;
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true', class: 'sic' })) svg.setAttribute(k, v);
  const a = document.createElementNS(NS, 'path');
  a.setAttribute('d', fill);
  a.setAttribute('class', 'sic-f');
  const b = document.createElementNS(NS, 'path');
  b.setAttribute('d', line);
  b.setAttribute('class', 'sic-l');
  svg.append(a, b);
  return svg;
}
