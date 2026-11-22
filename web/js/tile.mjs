// A project's colour: its name hashed into one of the theme's eight tile colours (--tile-0 … --tile-7), so the
// same project has the same colour in the sidebar, the rail and the breadcrumb, on every start. No DOM: tested in Node.
export const TILE_COUNT = 8;

/** 0 … 7 for `name`. Case and surrounding space do not change it; an empty name is 0. */
export function tileIndex(name) {
  const s = String(name || '').trim().toLowerCase();
  let n = 2166136261; // FNV-1a
  for (const ch of s) {
    n ^= ch.codePointAt(0);
    n = Math.imul(n, 16777619) >>> 0;
  }
  return s ? n % TILE_COUNT : 0;
}

/** The letter on the tile: the name's first letter or digit, upper-cased; '·' when it has none. */
export function tileLetter(name) {
  return (String(name || '').match(/[\p{L}\p{N}]/u)?.[0] || '·').toLocaleUpperCase();
}
