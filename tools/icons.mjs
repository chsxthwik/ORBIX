#!/usr/bin/env node
// The app icon and the website's icons, drawn from the one vector mark in web/js/dom.js. No dependencies: a
// headless Chromium (the one e2e/lib.mjs finds) rasterises each size on its own pixel grid, and the ICO is packed here.
//
//   node tools/icons.mjs              write assets/icon.ico (16 20 24 32 40 48 64 256), assets/icon.png (512) and the
//                                     site's favicon.ico, icon-192/512, icon-maskable-512 and apple-touch-icon
//   node tools/icons.mjs --check DIR  also write taskbar previews (light and dark, 100% and 150%) to DIR
//
// The tile is flat Ink with a hairline edge, so it reads on a light taskbar (the tile) and on a dark one (the edge and
// the light mark). From 16 to 64 px the X is hand-set on whole pixels (HINTS), so it stays sharp where Windows shows
// it most: the title bar, the taskbar, Alt+Tab and Explorer. Also writes site/assets/img/logo.svg, the vector icon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowser } from '../e2e/lib.mjs';
import { MARK, xPaths } from '../web/js/mark.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const CHECK = args.includes('--check') ? path.resolve(args[args.indexOf('--check') + 1] || 'icon-check') : '';
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

// The mark's geometry comes from the app (web/js/mark.js), so the icon and the title bar draw the same X.

/**
 * Hand-set geometry for the sizes Windows shows most (title bar 16, taskbar 24 and 32, Alt+Tab and Explorer 32 to 64),
 * in whole pixels: [mark height, width, arm, bend, waist]. The height, the arms' edges and the end cuts land on pixel
 * edges, and the mark is centred on whole pixels, so the X is sharp instead of a grey blur. Larger sizes scale MARK.
 */
export const HINTS = {
  16: [10, 10, 2, 2.35, 0.5],
  20: [14, 14, 3, 3.2, 0.65],
  24: [16, 16, 3, 3.5, 0.75],
  32: [20, 18, 4, 4.4, 0.9],
  40: [26, 24, 5, 5.7, 1.2],
  48: [28, 26, 6, 6.3, 1.3],
  64: [38, 36, 8, 8.5, 1.7],
};

/** The mark's box at `s` px: hinted where set, otherwise MARK scaled to 56 % of the tile (or `share`). */
export function markAt(s, share = 0.56) {
  if (HINTS[s] && share === 0.56) {
    const [H, W, arm, bend, waist] = HINTS[s];
    return { H, W, arm, bend, waist };
  }
  const k = (s * share) / MARK.H;
  return { H: MARK.H * k, W: MARK.W * k, arm: MARK.arm * k, bend: MARK.bend * k, waist: MARK.waist * k };
}

/** The tile: a superellipse (n = 5), the continuous corner of a premium icon instead of a circle-cornered square. */
function squircle(s, inset = 0, n = 5, N = 256) {
  const r = s / 2 - inset;
  const p = [];
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N, c = Math.cos(t), si = Math.sin(t);
    p.push(`${+(s / 2 + r * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(3)} ${+(s / 2 + r * Math.sign(si) * Math.abs(si) ** (2 / n)).toFixed(3)}`);
  }
  return `M${p.join('L')}Z`;
}

const INK = '#0B0B0C', BONE = '#F4F4F0';

/**
 * The icon at `s` px as SVG: a flat Ink tile with a hairline edge (so it holds on a dark taskbar) and the Bone X.
 * `bleed` fills the square (maskable, Apple) with the mark at `share` of it. No gradient, no glow.
 */
export function svg(s, { bleed = false, share = 0.56 } = {}) {
  const m = markAt(s, share);
  const x0 = (s - m.W) / 2, y0 = (s - m.H) / 2;
  const edge = s <= 32 ? 1 : s / 96;
  const tile = bleed ? `<rect width="${s}" height="${s}" fill="${INK}"/>`
    : `<path d="${squircle(s)}" fill="${INK}"/><path d="${squircle(s, edge / 2)}" fill="none" stroke="#FFFFFF" stroke-opacity="${s > 64 ? 0.09 : 0.14}" stroke-width="${edge}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${tile}<g fill="${BONE}">${xPaths(x0, y0, m).map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;
}

/** Rasterise SVG strings in the browser, each at its own size (one canvas pixel per icon pixel). Returns PNG buffers. */
async function rasterise(page, jobs) {
  const out = await page.eval(`
    const jobs = ${JSON.stringify(jobs)};
    const res = [];
    for (const { svg, w, h, bg } of jobs) {
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const g = c.getContext('2d');
      if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
      g.drawImage(img, 0, 0, w, h);
      res.push(c.toDataURL('image/png').split(',')[1]);
    }
    return res;`);
  return out.map((b) => Buffer.from(b, 'base64'));
}

/** An ICO file holding PNG images (Windows Vista and later read PNG entries at every size). */
export function packIco(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** The entries of an ICO file: [{ size, png }] (size from the PNG's own header). */
export function readIco(buf) {
  const n = buf.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + 16 * i;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    const data = buf.subarray(off, off + len);
    const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return { size: png ? data.readUInt32BE(16) : buf.readUInt8(e) || 256, png };
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-icons-'));
  const page = await startBrowser(path.join(dir, 'browser'), { width: 600, height: 400 });
  try {
    const write = (rel, data) => {
      fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, rel), data);
      console.log(`  ${rel} (${data.length.toLocaleString()} bytes)`);
    };
    const ico = await rasterise(page, ICO_SIZES.map((s) => ({ svg: svg(s), w: s, h: s })));
    write('assets/icon.ico', packIco(ICO_SIZES.map((size, i) => ({ size, data: ico[i] }))));
    const [png512, site192, site512, mask512, apple180, fav16, fav32, fav48] = await rasterise(page, [
      { svg: svg(512), w: 512, h: 512 },
      { svg: svg(192), w: 192, h: 192 },
      { svg: svg(512), w: 512, h: 512 },
      { svg: svg(512, { bleed: true, share: 0.4 }), w: 512, h: 512 }, // the mark inside the maskable safe zone
      { svg: svg(180, { bleed: true, share: 0.5 }), w: 180, h: 180 }, // iOS rounds the corners itself
      { svg: svg(16), w: 16, h: 16 },
      { svg: svg(32), w: 32, h: 32 },
      { svg: svg(48), w: 48, h: 48 },
    ]);
    write('assets/icon.png', png512);
    write('site/assets/img/logo.svg', Buffer.from(svg(1024).replace('<svg ', '<svg role="img" aria-label="ORBIX" ').replace(/ width="1024" height="1024"/, '').replace('>', '><title>ORBIX</title>') + '\n'));
    write('site/favicon.ico', packIco([{ size: 16, data: fav16 }, { size: 32, data: fav32 }, { size: 48, data: fav48 }]));
    write('site/assets/img/icon-192.png', site192);
    write('site/assets/img/icon-512.png', site512);
    write('site/assets/img/icon-maskable-512.png', mask512);
    write('site/assets/img/apple-touch-icon.png', apple180);
    if (CHECK) {
      // Taskbar previews: the icon as Windows shows it, on its light and dark taskbars, at 100% and 150% scaling.
      fs.mkdirSync(CHECK, { recursive: true });
      const sheet = (bg, scale) => {
        const sizes = scale === 1 ? [16, 24, 32, 48] : [24, 32, 48, 64];
        const w = sizes.reduce((a, s) => a + s + 24, 24);
        const body = sizes.map((s, i) => `<g transform="translate(${24 + sizes.slice(0, i).reduce((a, x) => a + x + 24, 0)} ${(80 - s) / 2})">${svg(s).replace(/<\/?svg[^>]*>/g, '')}</g>`).join('');
        return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="80" viewBox="0 0 ${w} 80"><rect width="${w}" height="80" fill="${bg}"/>${body}</svg>`, w, h: 80, bg };
      };
      const shots = await rasterise(page, [sheet('#F3F3F3', 1), sheet('#202020', 1), sheet('#F3F3F3', 1.5), sheet('#202020', 1.5)]);
      ['light-100', 'dark-100', 'light-150', 'dark-150'].forEach((n, i) => fs.writeFileSync(path.join(CHECK, `taskbar-${n}.png`), shots[i]));
      console.log(`  taskbar previews in ${CHECK}`);
    }
  } finally {
    page.close();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(() => process.exit(0), (e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
