// Generates the ORBIX logo with no image libraries:
//   assets/icon.png  (512 px)   assets/icon.ico  (16, 24, 32, 48, 64, 128, 256; PNG-compressed)
// Mark: a deep indigo tile, two orbits crossing like an X and woven (one strand over, one under), a bright core,
// and a node on the ring. Geometry is in a 64x64 design space and matches logo() in web/js/dom.js.
// Small sizes use thicker strokes, no glow and no weave gap.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT } from '../src/util.mjs';

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const over = (dst, src, a) => [mix(dst[0], src[0], a), mix(dst[1], src[1], a), mix(dst[2], src[2], a)];

const TILE_A = hex('#342b94');
const TILE_B = hex('#1c1863');
const TILE_C = hex('#100d3b');
const CORE_IN = hex('#ffffff');
const CORE_OUT = hex('#b9b1ff');
const GLOW = hex('#cfc8ff');
const A_FROM = hex('#c4baff'); // violet strand, light end to deep end along its long axis
const A_TO = hex('#6a5af9');
const B_FROM = hex('#a6f3ff'); // cyan strand
const B_TO = hex('#35aee6');
const NODE = hex('#8eeeff');
const SQ = Math.SQRT1_2;

/** Per-size drawing parameters (64-unit design space). */
function params(size) {
  if (size <= 16) return { ring: 5.6, core: 6.4, rx: 25, ry: 12.5, node: 4.8, glow: 0, gap: 0 };
  if (size <= 24) return { ring: 5, core: 6, rx: 26, ry: 12, node: 4.4, glow: 0.2, gap: 0 };
  if (size <= 32) return { ring: 4.6, core: 5.6, rx: 26.5, ry: 11.8, node: 4.2, glow: 0.35, gap: 1.4 };
  return { ring: 4, core: 5.2, rx: 27, ry: 11.5, node: 3.8, glow: 0.5, gap: 1.8 };
}

// Node: the long end of the violet strand (up and to the right).
const nodePos = (P) => [32 + P.rx * SQ, 32 - P.rx * SQ];

/** Distance to a strand (an ellipse whose long axis is turned by dir * 45 degrees) and how far along it the point is, 0..1. */
function strand(dx, dy, dir, P) {
  const a = (dir * Math.PI) / 4;
  const lx = dx * Math.cos(a) + dy * Math.sin(a);
  const ly = -dx * Math.sin(a) + dy * Math.cos(a);
  const k = Math.hypot(lx / P.rx, ly / P.ry);
  const g = Math.hypot(lx / (P.rx * P.rx), ly / (P.ry * P.ry));
  const ed = g > 1e-6 ? Math.abs(((k - 1) * k) / g) : 99;
  return { ed, t: clamp(0.5 + lx / (2 * P.rx)) };
}

function sample(x, y, aa, P, N) {
  const cov = (d) => clamp(0.5 - d / aa);
  // Tile: rounded square 3..61, radius 14.
  const qx = Math.abs(x - 32) - (29 - 14);
  const qy = Math.abs(y - 32) - (29 - 14);
  const tileD = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 14;
  const tile = cov(tileD);
  if (tile <= 0) return [0, 0, 0, 0];
  const t = clamp((x + y - 6) / 116);
  let c = t < 0.5 ? over(TILE_A, TILE_B, t * 2) : over(TILE_B, TILE_C, (t - 0.5) * 2);
  // A faint inner edge light, and a soft light from the top-left corner.
  c = over(c, [255, 255, 255], 0.16 * cov(Math.abs(tileD + 0.5) - 0.3));
  c = over(c, [255, 255, 255], 0.06 * (1 - smooth(0, 44, Math.hypot(x - 12, y - 8))));
  const base = c;

  const dx = x - 32;
  const dy = y - 32;
  const r = Math.hypot(dx, dy);
  if (P.glow) c = over(c, GLOW, P.glow * 0.55 * Math.pow(1 - smooth(P.core * 0.6, P.core * 2.6, r), 2));

  // Two strands. Violet (A) runs bottom-left to top-right, cyan (B) top-left to bottom-right.
  const A = strand(dx, dy, -1, P);
  const B = strand(dx, dy, 1, P);
  const covA = cov(A.ed - P.ring / 2);
  const covB = cov(B.ed - P.ring / 2);
  const colA = over(A_FROM, A_TO, A.t);
  const colB = over(B_FROM, B_TO, B.t);
  // Woven: A passes over B at the left and right crossings, B over A at the top and bottom.
  const aOver = Math.abs(dx) > Math.abs(dy);
  // Where the upper strand crosses, a thin band of tile colour separates it from the strand below.
  if (aOver) {
    c = over(c, colB, covB);
    if (P.gap) c = over(c, base, cov(A.ed - P.ring / 2 - P.gap) * covB);
    c = over(c, colA, covA);
  } else {
    c = over(c, colA, covA);
    if (P.gap) c = over(c, base, cov(B.ed - P.ring / 2 - P.gap) * covA);
    c = over(c, colB, covB);
  }

  // Core: a sphere lit from the top-left.
  const core = cov(r - P.core);
  if (core > 0) {
    const lit = clamp(Math.hypot(dx + P.core * 0.32, dy + P.core * 0.38) / (P.core * 1.25));
    c = over(c, over(CORE_IN, CORE_OUT, lit * lit), core);
  }
  // Node on the ring, with a small halo.
  const nd = Math.hypot(x - N[0], y - N[1]);
  if (P.glow) c = over(c, NODE, 0.45 * Math.pow(1 - smooth(P.node * 0.8, P.node * 2.6, nd), 2));
  c = over(c, NODE, cov(nd - P.node));
  return [c[0], c[1], c[2], tile * 255];
}

function render(size) {
  const P = params(size);
  const N = nodePos(P);
  const SS = size >= 128 ? 3 : 5;
  const unit = 64 / size;
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const [r, g, b, a] = sample((i + (si + 0.5) / SS) * unit, (j + (sj + 0.5) / SS) * unit, unit / SS, P, N);
          R += r * a; G += g * a; B += b * a; A += a;
        }
      }
      const o = (j * size + i) * 4;
      px[o] = A ? R / A : 0;
      px[o + 1] = A ? G / A : 0;
      px[o + 2] = A ? B / A : 0;
      px[o + 3] = A / (SS * SS);
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let j = 0; j < size; j++) px.copy(raw, j * (size * 4 + 1) + 1, j * size * 4, (j + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => ({ s, data: png(s, render(s)) }));

// ICO container: one PNG-compressed image per size.
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach((p, i) => {
  const o = 6 + i * 16;
  head[o] = p.s >= 256 ? 0 : p.s;
  head[o + 1] = p.s >= 256 ? 0 : p.s;
  head.writeUInt16LE(1, o + 4);
  head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(p.data.length, o + 8);
  head.writeUInt32LE(offset, o + 12);
  offset += p.data.length;
});

// --out <dir>: write into <dir> instead of assets/, plus every size as icon-<n>.png to check small sizes by eye.
const oi = process.argv.indexOf('--out');
const out = oi > 0 ? path.resolve(process.argv[oi + 1]) : path.join(ROOT, 'assets');
fs.mkdirSync(out, { recursive: true });
const busy = [];
for (const [name, data] of [['icon.png', png(512, render(512))], ['icon.ico', Buffer.concat([head, ...pngs.map((p) => p.data)])]]) {
  try {
    fs.writeFileSync(path.join(out, name), data);
  } catch (e) {
    if (e.code !== 'EBUSY') throw e;
    busy.push(name);
  }
}
if (busy.length) {
  console.error(`${busy.join(' and ')}: held open by a running ORBIX window. Close it and run this again.`);
  process.exitCode = 1;
}
if (oi > 0) for (const p of pngs) fs.writeFileSync(path.join(out, `icon-${p.s}.png`), p.data);
if (!busy.length) console.log(`wrote ${out}: icon.png (512) and icon.ico (${sizes.join(',')})`);
