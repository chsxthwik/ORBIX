// The sidebar's icons: one family on a 24px grid, a 1.75px outline with round caps and joins, nothing filled and
// nothing drawn inside a box, so every glyph has the same weight and size beside its label. The current page's
// icon takes the accent colour (CSS); the shapes never change with state.
const NS = 'http://www.w3.org/2000/svg';

export const SIDE_ICONS = {
  new: 'M12 5v14M5 12h14',
  search: 'M10.75 17.5a6.75 6.75 0 1 0 0-13.5 6.75 6.75 0 0 0 0 13.5ZM20 20l-4.25-4.25',
  // four tiles, the fourth a "+": things you add
  customizations: 'M5.5 4h3.5A1.5 1.5 0 0 1 10.5 5.5V9A1.5 1.5 0 0 1 9 10.5H5.5A1.5 1.5 0 0 1 4 9V5.5A1.5 1.5 0 0 1 5.5 4ZM5.5 13.5h3.5a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 18.5V15a1.5 1.5 0 0 1 1.5-1.5ZM15 13.5h3.5a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H15a1.5 1.5 0 0 1-1.5-1.5V15a1.5 1.5 0 0 1 1.5-1.5ZM16.75 4v6.5M13.5 7.25H20',
  skills: 'M11 4l1.6 4.4L17 10l-4.4 1.6L11 16l-1.6-4.4L5 10l4.4-1.6ZM18 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z',
  // a turn of the clock that comes back on itself
  automations: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v3.75h-3.75M12 8.5V12l2.5 1.75',
  // a run: steps that lead to a finish
  runs: 'M5 6.5h7M5 12h10M5 17.5h5M17.5 15.5 20 18l-2.5 2.5',
  // decisions waiting: an open tray with a check above it
  review: 'M4 13.5 6.2 6a1.5 1.5 0 0 1 1.45-1.1h8.7A1.5 1.5 0 0 1 17.8 6l2.2 7.5M4 13.5h4.25l1.5 2.5h4.5l1.5-2.5H20V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18ZM9.5 9.25l1.75 1.75L14.5 7.75',
  settings: 'M12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5ZM19.2 14.6a1.6 1.6 0 0 0 .32 1.77l.06.06a1.94 1.94 0 1 1-2.75 2.75l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47v.16a1.94 1.94 0 1 1-3.88 0v-.08a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a1.94 1.94 0 1 1-2.75-2.75l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97h-.16a1.94 1.94 0 1 1 0-3.88h.08a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a1.94 1.94 0 1 1 2.75-2.75l.06.06a1.6 1.6 0 0 0 1.77.32h.08a1.6 1.6 0 0 0 .97-1.47v-.16a1.94 1.94 0 1 1 3.88 0v.08a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a1.94 1.94 0 1 1 2.75 2.75l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.97h.16a1.94 1.94 0 1 1 0 3.88h-.08a1.6 1.6 0 0 0-1.47.97Z',
};

/** A sidebar icon by page name (`new`, `search`, a hub view such as `runs`, `settings`). */
export function sideIcon(name, size = 18) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'sic' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', SIDE_ICONS[name] || SIDE_ICONS.new);
  svg.append(p);
  return svg;
}
