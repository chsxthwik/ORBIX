#!/usr/bin/env node
// The app icon and the website's icons, drawn from the one vector mark in web/js/dom.js. No dependencies: a
// headless Chromium (the one e2e/lib.mjs finds) rasterises each size on its own pixel grid, and the ICO is packed here.
//
//   node tools/icons.mjs              write assets/icon.ico (16 20 24 32 40 48 64 256), assets/icon.png (512) and the
//                                     site's favicon.ico, icon-192/512, icon-maskable-512 and apple-touch-icon
//   node tools/icons.mjs --check DIR  also write taskbar previews (light and dark, 100% and 150%) to DIR
//
// The tile is the mark's dark tile with a hairline edge, so it reads on a light taskbar (the tile) and on a dark one
// (the edge and the light mark). At 40px and below the mark is drawn larger (at least 62% of the tile) and snapped
// to whole pixels, so it stays sharp where Windows shows it most: the taskbar, Alt+Tab and the title bar.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowser } from '../e2e/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const CHECK = args.includes('--check') ? path.resolve(args[args.indexOf('--check') + 1] || 'icon-check') : '';
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

// The mark's two halves, read from the app so there is one source of truth.
const dom = fs.readFileSync(path.join(ROOT, 'web', 'js', 'dom.js'), 'utf8');
const HALF_L = /const HALF_L = '([^']+)'/.exec(dom)[1];
const HALF_R = /const HALF_R = '([^']+)'/.exec(dom)[1];
// The X: each half moved 45 units across (as .logo draws it at rest). Its box in mark units: x 4.65 … 95.35, y 0 … 100.
const X0 = 4.65, XW = 90.7;

/** How much of the tile the mark's height takes: more at small sizes, where every pixel counts. */
const markShare = (s) => (s <= 24 ? 0.68 : s <= 40 ? 0.64 : s <= 64 ? 0.56 : 0.52);

/** The icon at `s` px as SVG: `bleed` fills the square (maskable, Apple), otherwise a rounded tile on transparency. */
function svg(s, { bleed = false, share = markShare(s) } = {}) {
  const H = Math.round(s * share); // whole-pixel mark height
  const k = H / 100;
  const left = Math.round((s - XW * k) / 2);
  const top = Math.round((s - H) / 2);
  const r = bleed ? 0 : s <= 20 ? Math.round(s * 0.22) : s * 0.225;
  const edge = s <= 32 ? 1 : s / 96; // a hairline at every size
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26262A"/><stop offset="1" stop-color="#0B0B0C"/></linearGradient></defs>
<rect width="${s}" height="${s}" rx="${r}" fill="url(#g)"/>
${bleed ? '' : `<rect x="${edge / 2}" y="${edge / 2}" width="${s - edge}" height="${s - edge}" rx="${Math.max(0, r - edge / 2)}" fill="none" stroke="#FFFFFF" stroke-opacity="${s > 64 ? 0.08 : 0.14}" stroke-width="${edge}"/>`}
<g transform="translate(${left - X0 * k} ${top}) scale(${k})" fill="#F4F4F0"><path transform="translate(45 0)" d="${HALF_L}"/><path transform="translate(-45 0)" d="${HALF_R}"/></g>
</svg>`;
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
