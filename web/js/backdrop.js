// Scene themes: a living picture behind the workspace sheet. Each scene theme (see SCENES) paints a still layer once
// per size, then animates a few things on top: a planet's ring, a neon grid, drifting nebula clouds, an aurora, clouds
// over a dot-engraved landscape. While an
// agent works, the scene moves a little faster; when a turn finishes cleanly, fireworks go up at the sides.
// A soft veil of the sheet colour sits over the reading column, so text always reads first.
// Runs at 30 frames a second in front (about 10 behind other windows), stops while the window is hidden, and is one
// still frame under reduced motion or when Settings → Appearance → Animate scenes is off.
import { S, on } from './store.js';

export const SCENES = ['orbix', 'sunset', 'nebula', 'aurora', 'dither'];

const root = document.documentElement;
const still = matchMedia('(prefers-reduced-motion: reduce)');
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** A small seeded random source, so a scene's mountains and trees stay put when the window resizes. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const offscreen = () => document.createElement('canvas');
function sized(c, w, h) {
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

let canvas = null, ctx = null, host = null, ro = null;
const base = offscreen(), veil = offscreen();
let scene = null, current = '', live = false, raf = 0;
let W = 0, H = 0, dpr = 1, T = 0, last = 0, drawn = 0;
let sparks = [], rockets = []; // fireworks in the air (window coordinates)

const busy = () => [...S.tabs.values()].some((t) => t.streaming && !t.dead);
const animated = () => !still.matches && S.ui?.sceneMotion !== false && S.ui?.screenReader !== true;

// ---------------------------------------------------------------- shared pieces

/** A comet: a short streak high on the sheet, now and then. */
function comets() {
  let c = null, next = 0;
  return (g, ink) => {
    if (!next) next = T + 6 + Math.random() * 6;
    if (!c && T > next) {
      const ang = (16 + Math.random() * 16) * (Math.PI / 180);
      c = { t0: T, dur: 0.9 + Math.random() * 0.5, x: W * (0.1 + Math.random() * 0.55), y: H * (0.04 + Math.random() * 0.2), dx: Math.cos(ang), dy: Math.sin(ang), len: Math.min(W, 900) * (0.25 + Math.random() * 0.15) };
      next = T + 12 + Math.random() * 16;
    }
    if (!c) return;
    const t = (T - c.t0) / c.dur;
    if (t >= 1) return void (c = null);
    const x = c.x + c.dx * c.len * t, y = c.y + c.dy * c.len * t;
    const tail = g.createLinearGradient(x, y, x - c.dx * 110, y - c.dy * 110);
    tail.addColorStop(0, ink);
    tail.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = Math.sin(t * Math.PI) * 0.7;
    g.strokeStyle = tail;
    g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - c.dx * 110, y - c.dy * 110);
    g.stroke();
    g.globalAlpha = 1;
  };
}

function starField(g, n, top, bottom, ink, seed, maxA = 0.5) {
  const r = rng(seed);
  g.fillStyle = ink;
  for (let i = 0; i < n; i++) {
    const s = r() < 0.1 ? 1.6 : 1;
    g.globalAlpha = 0.08 + r() * maxA;
    g.fillRect(r() * W, top + r() * (bottom - top), s, s);
  }
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------- ORBIX: the mark as a planet and ring

function orbixScene() {
  let R, Rp, cx, cy, pts = [], tw = [], head = 0, spin = 0, comet = comets();
  const TILT = (16 * Math.PI) / 180, cT = Math.cos(TILT), sT = Math.sin(TILT);
  const FLAT = 0.27; // how open the ring is: 0 edge-on, 1 face-on
  const D = 4.2, F = 3.6;
  return {
    sparks: ['#3DF28C', '#E4E2FF', '#9C8BFF', '#FFFFFF'],
    setup() {
      R = clamp(Math.min(W, H) * 0.25, 100, 250);
      Rp = (R * F) / D;
      cx = W - R * 1.1;
      cy = H - R * 1.2;
      pts = [];
      const nS = Math.round(1500 * clamp(R / 270, 0.5, 1)), ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < nS; i++) {
        const y = 1 - (i / (nS - 1)) * 2, r = Math.sqrt(1 - y * y);
        pts.push({ ring: false, x: Math.cos(ga * i) * r, y, z: Math.sin(ga * i) * r });
      }
      const nR = Math.round(2600 * clamp(R / 250, 0.5, 1));
      for (let i = 0; i < nR; i++) pts.push({ ring: true, a: Math.random() * TAU, rad: 1.4 + Math.pow(Math.random(), 1.4) * 0.5, h: (Math.random() - 0.5) * 0.025 });
      tw = Array.from({ length: 40 }, () => ({ x: Math.random() * W, y: Math.random() * H * 0.7, p: Math.random() * TAU }));
    },
    paint(g) {
      const haze = g.createRadialGradient(cx, cy, Rp * 0.6, cx, cy, Rp * 3.4);
      haze.addColorStop(0, 'rgba(118,92,255,.20)');
      haze.addColorStop(1, 'rgba(118,92,255,0)');
      g.fillStyle = haze;
      g.fillRect(0, 0, W, H);
      starField(g, Math.round((W * H) / 9000), 0, H, '#E4E2FF', 7, 0.35);
      // The body: dark, lit from the upper left, with a thin atmosphere at the rim.
      g.fillStyle = css('--bg', '#090A10');
      g.beginPath(); g.arc(cx, cy, Rp, 0, TAU); g.fill();
      const body = g.createRadialGradient(cx - Rp * 0.45, cy - Rp * 0.5, Rp * 0.05, cx, cy, Rp);
      body.addColorStop(0, 'rgba(170,150,255,.55)');
      body.addColorStop(0.55, 'rgba(70,55,160,.18)');
      body.addColorStop(1, 'rgba(10,10,20,.2)');
      g.fillStyle = body;
      g.beginPath(); g.arc(cx, cy, Rp, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(228,226,255,.5)';
      g.lineWidth = 1.4;
      g.beginPath(); g.arc(cx, cy, Rp, Math.PI * 0.9, Math.PI * 1.75); g.stroke();
    },
    frame(g, dt, fast) {
      spin += dt * 0.06;
      head += dt * (fast ? 2.6 : 0.8);
      g.fillStyle = '#E4E2FF';
      for (const s of tw) {
        g.globalAlpha = 0.1 + 0.35 * (0.5 + 0.5 * Math.sin((s.p += dt * 1.1)));
        g.fillRect(s.x, s.y, 1.4, 1.4);
      }
      const cs = Math.cos(spin), ss = Math.sin(spin);
      for (const p of pts) {
        let x, y, z, al, lit = false;
        if (!p.ring) {
          z = -p.x * ss + p.z * cs;
          if (z > 0.02) continue; // the far side is behind the body
          x = p.x * cs + p.z * ss; y = p.y;
          const rim = 1 - Math.abs(z);
          // light from the upper left, a rim all round
          const sun = clamp(0.5 - 0.5 * (x * 0.6 + y * 0.7), 0, 1);
          al = 0.05 + 0.55 * Math.pow(rim, 3) + 0.2 * sun * (1 - rim);
        } else {
          const a = p.a + (spin * 1.7) / p.rad;
          const rx = Math.cos(a) * p.rad, rz = Math.sin(a) * p.rad;
          const sy = -rz * FLAT + p.h;
          x = rx * cT - sy * sT; y = rx * sT + sy * cT; z = rz * 0.96;
          const behind = (((head - a) % TAU) + TAU) % TAU;
          lit = behind < 1.0;
          al = lit ? 0.45 + 0.55 * (1 - behind) : 0.22 + 0.4 * clamp(0.5 - z / 4, 0, 1);
        }
        const s = F / (D + z);
        const px = cx + x * R * s, py = cy + y * R * s;
        if (p.ring && z > 0 && (px - cx) ** 2 + (py - cy) ** 2 < Rp * Rp) continue; // behind the planet
        if (px < -2 || py < -2 || px > W + 2 || py > H + 2) continue;
        const q = (lit ? 2.2 : p.ring ? 1.6 : 1.5) * Math.min(1.4, s);
        g.globalAlpha = al;
        g.fillStyle = lit ? '#3DF28C' : '#E4E2FF';
        g.fillRect(px - q / 2, py - q / 2, q, q);
      }
      g.globalAlpha = 1;
      comet(g, '#E4E2FF');
    },
  };
}

// ---------------------------------------------------------------- Sunset: a neon grid running to a striped sun

function sunsetScene() {
  let hy, sx, sy, Rs, phase = 0, left = [], right = [];
  const ridge = (r, x0, x1, top) => {
    const p = [];
    for (let x = x0; x <= x1 + 1; x += 18 + r() * 26) p.push([x, hy - r() * top]);
    p.push([x1, hy]);
    return p;
  };
  return {
    sparks: ['#FF4FB8', '#4FE3FF', '#FFE27A', '#FFFFFF'],
    setup() {
      hy = Math.round(H * 0.6);
      Rs = clamp(Math.min(W, H) * 0.2, 80, 210);
      sx = W - Math.max(Rs * 1.25, W * 0.13);
      sy = hy - Rs * 0.3;
      const r = rng(21);
      left = ridge(r, 0, W * 0.34, H * 0.14);
      right = ridge(r, W * 0.6, W, H * 0.1);
    },
    paint(g) {
      const sky = g.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, '#0D0620');
      sky.addColorStop(0.5, '#220C3E');
      sky.addColorStop(0.85, '#4E1250');
      sky.addColorStop(1, '#7E1E5E');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, hy);
      starField(g, Math.round((W * hy) / 7000), 0, hy * 0.6, '#FFE9FF', 3, 0.5);
      // glow, then the sun cut by widening bands
      const glow = g.createRadialGradient(sx, sy, Rs * 0.4, sx, sy, Rs * 2.6);
      glow.addColorStop(0, 'rgba(255,80,170,.42)');
      glow.addColorStop(1, 'rgba(255,80,170,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, hy);
      const sun = offscreen(), sg = sized(sun, W, H);
      const fill = sg.createLinearGradient(0, sy - Rs, 0, sy + Rs);
      fill.addColorStop(0, '#FFE27A');
      fill.addColorStop(0.45, '#FF9A4D');
      fill.addColorStop(1, '#FF2E8A');
      sg.fillStyle = fill;
      sg.beginPath(); sg.arc(sx, sy, Rs, 0, TAU); sg.fill();
      sg.globalCompositeOperation = 'destination-out';
      for (let i = 0, y = sy - Rs * 0.05; i < 8 && y < sy + Rs; i++) {
        const h = 2 + i * 1.6;
        sg.fillRect(sx - Rs - 2, y, Rs * 2 + 4, h);
        y += h + Rs * 0.13 - i * 1.2;
      }
      g.save();
      g.beginPath(); g.rect(0, 0, W, hy); g.clip();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(sun, 0, 0);
      g.restore();
      for (const ridgePts of [left, right]) {
        g.beginPath();
        g.moveTo(ridgePts[0][0], hy);
        for (const [x, y] of ridgePts) g.lineTo(x, y);
        g.closePath();
        g.fillStyle = '#150828';
        g.fill();
        g.beginPath();
        ridgePts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.strokeStyle = 'rgba(255,79,184,.65)';
        g.lineWidth = 1.2;
        g.stroke();
      }
      const floor = g.createLinearGradient(0, hy, 0, H);
      floor.addColorStop(0, '#1A0833');
      floor.addColorStop(1, '#07030F');
      g.fillStyle = floor;
      g.fillRect(0, hy, W, H - hy);
      const line = g.createLinearGradient(0, hy - 6, 0, hy + 6);
      line.addColorStop(0, 'rgba(255,79,184,0)');
      line.addColorStop(0.5, 'rgba(255,120,200,.9)');
      line.addColorStop(1, 'rgba(255,79,184,0)');
      g.fillStyle = line;
      g.fillRect(0, hy - 6, W, 12);
    },
    frame(g, dt, fast) {
      phase = (phase + dt * (fast ? 1.1 : 0.32)) % 1;
      const vx = W / 2, depth = H - hy;
      g.strokeStyle = '#FF4FB8';
      g.lineWidth = 1;
      // rows rush toward you
      for (let k = 0; k < 26; k++) {
        const z = k + 1 - phase;
        const y = hy + (depth * 0.9) / z;
        if (y > H + 2) continue;
        g.globalAlpha = clamp(((y - hy) / depth) * 1.6, 0, 0.75);
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      // columns run to the vanishing point
      g.globalAlpha = 0.5;
      const n = Math.ceil(W / 60);
      g.beginPath();
      for (let i = -n; i <= n; i++) {
        g.moveTo(vx + i * 7, hy);
        g.lineTo(vx + i * 120, H + 40);
      }
      g.stroke();
      g.globalAlpha = 1;
    },
  };
}

// ---------------------------------------------------------------- Aurora: curtains of light over a pine ridge

function auroraScene() {
  let bands = [], trees = [], sprites = [], comet = comets();
  const COLS = [[94, 242, 176], [61, 217, 214], [155, 140, 255]];
  return {
    sparks: ['#5EF2B0', '#9B8CFF', '#3DD9D6', '#FFFFFF'],
    setup() {
      sprites = COLS.map(([r, g2, b]) => {
        const c = offscreen();
        c.width = 1; c.height = 128;
        const g = c.getContext('2d');
        const lg = g.createLinearGradient(0, 0, 0, 128);
        lg.addColorStop(0, `rgba(${r},${g2},${b},0)`);
        lg.addColorStop(0.75, `rgba(${r},${g2},${b},.55)`);
        lg.addColorStop(0.95, `rgba(${r},${g2},${b},1)`);
        lg.addColorStop(1, `rgba(${r},${g2},${b},0)`);
        g.fillStyle = lg;
        g.fillRect(0, 0, 1, 128);
        return c;
      });
      bands = [
        { y: 0.24, amp: 0.05, f: 0.0042, sp: 0.35, len: 0.2, c: 0, ph: 0 },
        { y: 0.3, amp: 0.04, f: 0.0031, sp: -0.25, len: 0.16, c: 1, ph: 2 },
        { y: 0.19, amp: 0.035, f: 0.0055, sp: 0.2, len: 0.12, c: 2, ph: 4 },
      ];
      const r = rng(13);
      trees = [];
      for (let x = -10; x < W + 20; x += 14 + r() * 22) {
        const edge = Math.min(x, W - x) / W; // tall at the sides, low in the middle
        const h = H * (0.07 + r() * 0.06 + clamp(0.3 - edge, 0, 0.3) * 0.5);
        trees.push([x, h, 10 + r() * 10]);
      }
    },
    paint(g) {
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#030A12');
      sky.addColorStop(0.6, '#061519');
      sky.addColorStop(1, '#0A1F1C');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      starField(g, Math.round((W * H) / 6000), 0, H * 0.8, '#DFFFF4', 11, 0.45);
      for (const [x, h, w] of trees) {
        g.fillStyle = '#030C0B';
        for (let k = 0; k < 4; k++) {
          const top = H - h + (k * h) / 5, half = (w * (k + 1.4)) / 4;
          g.beginPath(); g.moveTo(x, top); g.lineTo(x - half, top + h / 2.6); g.lineTo(x + half, top + h / 2.6); g.closePath(); g.fill();
        }
        g.fillRect(x - w / 2, H - h * 0.35, w, h * 0.35);
        g.fillStyle = 'rgba(190,255,230,.10)';
        g.fillRect(x - 1, H - h, 2, 2);
      }
    },
    frame(g, dt, fast) {
      const k = fast ? 2.2 : 1;
      g.globalCompositeOperation = 'lighter';
      for (const b of bands) {
        b.ph += dt * b.sp * k;
        const sprite = sprites[b.c];
        for (let x = 0; x < W; x += 4) {
          const y = H * b.y + H * b.amp * Math.sin(x * b.f + b.ph) + H * b.amp * 0.5 * Math.sin(x * b.f * 2.3 - b.ph * 1.3);
          const glow = Math.pow(0.5 + 0.5 * Math.sin(x * 0.0037 + T * 0.45 * k + b.ph), 2);
          const len = H * b.len * (0.55 + 0.45 * glow);
          g.globalAlpha = 0.08 + 0.32 * glow;
          g.drawImage(sprite, x, y - len, 4, len);
        }
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      comet(g, '#DFFFF4');
    },
  };
}

// ---------------------------------------------------------------- Nebula: slow clouds of colour in deep space

function nebulaScene() {
  let clouds = [], twinkle = [], sprites = [], comet = comets();
  // violet, magenta, blue, teal: soft glows that drift and breathe, drawn with additive light
  const COLS = [[139, 92, 246], [236, 72, 153], [59, 130, 246], [45, 212, 191]];
  return {
    sparks: ['#A78BFA', '#F472B6', '#60A5FA', '#FFFFFF'],
    setup() {
      sprites = COLS.map(([r, g2, b]) => {
        const c = offscreen();
        c.width = c.height = 256;
        const g = c.getContext('2d');
        const rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
        rg.addColorStop(0, `rgba(${r},${g2},${b},.55)`);
        rg.addColorStop(0.35, `rgba(${r},${g2},${b},.22)`);
        rg.addColorStop(0.7, `rgba(${r},${g2},${b},.06)`);
        rg.addColorStop(1, `rgba(${r},${g2},${b},0)`);
        g.fillStyle = rg;
        g.fillRect(0, 0, 256, 256);
        return c;
      });
      const r = rng(29), S0 = Math.max(W, H);
      // most of the colour lives toward the right and the corners, away from the reading column
      const spots = [[0.86, 0.18, 0], [0.97, 0.62, 1], [0.72, 0.92, 2], [0.08, 0.86, 3], [0.04, 0.12, 2], [0.62, 0.05, 1], [0.9, 0.42, 3]];
      clouds = spots.map(([x, y, c]) => ({ x, y, c, s: S0 * (0.38 + r() * 0.3), ax: 0.02 + r() * 0.03, ay: 0.02 + r() * 0.03, f: 0.04 + r() * 0.05, ph: r() * TAU, a: 0.7 + r() * 0.3 }));
      const q = rng(41);
      twinkle = Array.from({ length: Math.round(clamp((W * H) / 22000, 24, 90)) }, () => ({ x: q() * W, y: q() * H, s: q() < 0.25 ? 1.8 : 1.2, f: 0.6 + q() * 1.6, ph: q() * TAU, hue: q() < 0.3 ? '#C7D2FE' : q() < 0.5 ? '#FBCFE8' : '#FFFFFF' }));
    },
    paint(g) {
      const sky = g.createLinearGradient(0, 0, W, H);
      sky.addColorStop(0, '#06060F');
      sky.addColorStop(0.55, '#0A0818');
      sky.addColorStop(1, '#0B0A1C');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      starField(g, Math.round((W * H) / 3200), 0, H, '#E8E6FF', 7, 0.4);
      starField(g, Math.round((W * H) / 26000), 0, H, '#FFFFFF', 19, 0.7);
      // a fine grain, so the gradients never band
      const n = offscreen();
      n.width = n.height = 96;
      const ng = n.getContext('2d'), img = ng.createImageData(96, 96), r = rng(5);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 255 * r();
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 10;
      }
      ng.putImageData(img, 0, 0);
      g.fillStyle = g.createPattern(n, 'repeat');
      g.fillRect(0, 0, W, H);
    },
    frame(g, dt, fast) {
      const k = fast ? 2.4 : 1;
      g.globalCompositeOperation = 'lighter';
      for (const c of clouds) {
        c.ph += dt * c.f * k;
        const x = W * (c.x + c.ax * Math.sin(c.ph)), y = H * (c.y + c.ay * Math.cos(c.ph * 0.8));
        const s = c.s * (0.92 + 0.08 * Math.sin(c.ph * 1.7));
        g.globalAlpha = c.a * (0.8 + 0.2 * Math.sin(c.ph * 1.3 + 1));
        g.drawImage(sprites[c.c], x - s / 2, y - s / 2, s, s);
      }
      g.globalCompositeOperation = 'source-over';
      for (const t of twinkle) {
        const a = Math.pow(0.5 + 0.5 * Math.sin(T * t.f * k + t.ph), 3);
        if (a < 0.05) continue;
        g.globalAlpha = a * 0.9;
        g.fillStyle = t.hue;
        g.fillRect(t.x - t.s / 2, t.y - t.s / 2, t.s, t.s);
        if (t.s > 1.5 && a > 0.6) {
          g.globalAlpha = (a - 0.6) * 0.8;
          g.fillRect(t.x - 4, t.y - 0.5, 8, 1);
          g.fillRect(t.x - 0.5, t.y - 4, 1, 8);
        }
      }
      g.globalAlpha = 1;
      comet(g, '#E8E6FF');
    },
  };
}

// ---------------------------------------------------------------- Dither: an engraving in square dots of one colour
// A procedural landscape (ridges, a low moon, a hill of ruined columns) turned into dots by an 8x8 Bayer matrix: a
// cell gets a dot when the picture's brightness there beats the matrix's threshold. The still picture is dithered once
// per size; each frame only the cloud band is re-dithered, and only the cells that change are drawn (a dot, or the
// sheet colour over one). A few dots near their threshold shimmer.

/** The 8x8 Bayer matrix as thresholds in (0, 1). */
function bayer8() {
  let m = [[0]];
  for (let s = 1; s < 8; s *= 2) {
    const n = [];
    for (let y = 0; y < s * 2; y++) {
      n.push([]);
      for (let x = 0; x < s * 2; x++) n[y].push(4 * m[y % s][x % s] + [[0, 2], [3, 1]][(y / s) | 0][(x / s) | 0]);
    }
    m = n;
  }
  return Float32Array.from(m.flat(), (v) => (v + 0.5) / 64);
}

/** Smooth 1D value noise (a few octaves), 0..1, for ridge lines. */
function noise1(seed) {
  const r = rng(seed), P = Float32Array.from({ length: 1024 }, r);
  const at = (t) => {
    const i = Math.floor(t), f = t - i, s = f * f * (3 - 2 * f), a = P[i & 1023];
    return a + (P[(i + 1) & 1023] - a) * s;
  };
  return (t) => {
    let v = 0, amp = 0.5, tot = 0;
    for (let o = 0; o < 5; o++, amp *= 0.5, t *= 2.03) (v += at(t + o * 31.7) * amp), (tot += amp);
    return v / tot;
  };
}

/** A tileable 2D value-noise texture (nx by ny), stretched to 0..1: the clouds and the moon's seas. */
function tileNoise(nx, ny, seed) {
  const r = rng(seed), out = new Float32Array(nx * ny);
  for (let o = 0, amp = 1; o < 4; o++, amp *= 0.5) {
    const lx = 8 << o, ly = 2 << o, L = Float32Array.from({ length: lx * ly }, r);
    for (let y = 0; y < ny; y++) {
      const fy = (y / ny) * ly, y0 = fy | 0, ty = fy - y0, sy = ty * ty * (3 - 2 * ty), y1 = (y0 + 1) % ly;
      for (let x = 0; x < nx; x++) {
        const fx = (x / nx) * lx, x0 = fx | 0, tx = fx - x0, sx = tx * tx * (3 - 2 * tx), x1 = (x0 + 1) % lx;
        const a = L[y0 * lx + x0] + (L[y0 * lx + x1] - L[y0 * lx + x0]) * sx;
        const b = L[y1 * lx + x0] + (L[y1 * lx + x1] - L[y1 * lx + x0]) * sx;
        out[y * nx + x] += (a + (b - a) * sy) * amp;
      }
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of out) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo || 1);
  return out;
}

function ditherScene() {
  const BAYER = bayer8(), NX = 256, NY = 64, ALPHA = [0, 0.5, 0.78, 1];
  const smooth = (a, b, v) => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const tone = (b) => (b < 0.3 ? 1 : b < 0.6 ? 2 : 3); // a dot's strength follows the picture's brightness
  let tex = null, ink = '', bg = '', c = 3, d = 2, gw = 0, gh = 0;
  let bS = null, thr = null, lit = null; // per cell: still brightness, Bayer threshold, still tone (0 = no dot)
  let band = null, shim = null, out = null; // the cloud band, the shimmering cells, per-frame lists
  let offA = 37, offB = 113, sh = 0; // cloud drift and shimmer clocks: kept across resizes

  /** Stamp a rectangle (window coordinates) into a per-cell layer, its brightness from a function of 0..1 across. */
  const stamp = (layer, x0, y0, x1, y1, f) => {
    const a = clamp(Math.floor(x0 / c), 0, gw), b = clamp(Math.ceil(x1 / c), 0, gw);
    for (let gy = clamp(Math.floor(y0 / c), 0, gh); gy < clamp(Math.ceil(y1 / c), 0, gh); gy++)
      for (let gx = a; gx < b; gx++) layer[gy * gw + gx] = f(((gx + 0.5) * c - x0) / (x1 - x0));
  };

  return {
    sparks: [],
    setup() {
      tex ||= tileNoise(NX, NY, 61);
      ink = css('--plasma', '#3DF28C');
      bg = css('--bg', '#070908');
      this.sparks = [ink, ink, css('--fg', '#E9F1EC'), '#FFFFFF'];
      c = W * H > 1.3e6 ? 4 : 3;
      d = c - 1;
      gw = Math.ceil(W / c); gh = Math.ceil(H / c);
      const N = gw * gh;
      bS = new Float32Array(N); thr = new Float32Array(N); lit = new Uint8Array(N);

      // The open sides carry the picture; the middle, under the logo and the reading column, stays quiet.
      const cw = clamp(W * 0.2, 160, 380);
      const calm = Float32Array.from({ length: gw }, (_, gx) => 1 - 0.74 * Math.exp(-((((gx + 0.5) * c - W / 2) / cw) ** 2)));

      // A large low moon, off to the right like the other scenes' suns and planets.
      const R = clamp(Math.min(W, H) * 0.2, 80, 230), mx = W - Math.max(R * 1.35, W * 0.16), my = H * 0.6;

      // Four ridges, far to near: tall at the sides, low in the middle.
      const LAYERS = [
        { base: 0.64, amp: 0.24, scale: 0.2, b: 0.2 },
        { base: 0.74, amp: 0.2, scale: 0.16, b: 0.13 },
        { base: 0.84, amp: 0.16, scale: 0.13, b: 0.08 },
        { base: 0.97, amp: 0.13, scale: 0.1, b: 0.03 },
      ];
      const tops = LAYERS.map((L, i) => {
        const f = noise1(101 + i * 17), raw = Float32Array.from({ length: gw }, (_, gx) => f(((gx + 0.5) * c) / (W * L.scale) + i * 7.3));
        let lo = Infinity, hi = -Infinity;
        for (const v of raw) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
        return raw.map((v, gx) => {
          const edge = Math.abs(((gx + 0.5) * c) / W - 0.5) * 2, peak = (v - lo) / (hi - lo || 1);
          return H * L.base - H * L.amp * (0.3 + 0.7 * edge ** 0.9) * (0.12 + 0.88 * peak ** 1.4);
        });
      });

      // Ruins on the third ridge, at the left: the hilltop levelled, a stylobate, columns (some broken), an architrave.
      const ruin = new Float32Array(N).fill(-1);
      const r = rng(77), sp = clamp(W * 0.024, 18, 34), colW = Math.max(c * 3, sp * 0.42), n = 6;
      const xa = W * 0.07, xb = xa + (n - 1) * sp;
      const g0 = Math.floor((xa - sp) / c), g1 = Math.ceil((xb + sp) / c);
      let ground = 0, cnt = 0;
      for (let gx = clamp(g0, 0, gw - 1); gx <= clamp(g1, 0, gw - 1); gx++) (ground += tops[2][gx]), cnt++;
      ground = Math.min(ground / (cnt || 1), H * 0.8);
      for (let gx = 0; gx < gw; gx++) {
        const x = (gx + 0.5) * c, w = 1 - smooth(0, sp * 2.5, Math.max(xa - sp - x, x - xb - sp, 0));
        tops[2][gx] += (ground - tops[2][gx]) * w;
      }
      const hCol = clamp(H * 0.085, 48, 104), cols = [];
      for (let i = 0; i < n; i++) {
        const whole = i === 1 || i === 2 || (i !== 0 && r() > 0.45);
        cols.push({ x: xa + i * sp, h: whole ? hCol : hCol * (0.25 + 0.5 * r()), whole });
      }
      stamp(ruin, xa - colW, ground - c * 2, xb + colW, ground + c * 2, () => 0.34); // the step, its top lit
      for (const k of cols) {
        // dark shaft against the hazy ridges behind, its moon side lit
        stamp(ruin, k.x - colW / 2, ground - k.h, k.x + colW / 2, ground - c * 2, (u) => (u > 0.66 ? 0.44 : u > 0.33 ? 0.08 : 0.02));
        if (k.whole) stamp(ruin, k.x - colW * 0.8, ground - k.h - c * 2, k.x + colW * 0.8, ground - k.h, (u) => (u > 0.6 ? 0.56 : 0.3));
      }
      for (let i = 0; i < n; ) {
        let j = i;
        while (j + 1 < n && cols[i].whole && cols[j + 1].whole) j++;
        if (j > i) stamp(ruin, cols[i].x - colW * 0.8, ground - hCol - c * 4, cols[j].x + colW * 0.8, ground - hCol - c * 2, () => 0.4);
        i = j + 1;
      }

      // The still picture, cell by cell (what does not change along a row or a column is worked out once).
      const stars = rng(83), bandTop = H * 0.06, bandBot = H * 0.56, inBand = [];
      const moonward = Float32Array.from({ length: gw }, (_, gx) => 0.6 + 0.4 * Math.exp(-Math.abs((gx + 0.5) * c - mx) / (W * 0.35)));
      const slopes = tops.map((t) => Float32Array.from(t, (_, gx) => (t[Math.min(gw - 1, gx + 1)] - t[Math.max(0, gx - 1)]) / (2 * c))); // > 0: the face looks toward the moon
      const kHaze = -1 / (H * 0.08), kShade = -1 / (H * 0.1), kCrest = -1 / (c * 1.2), kNear = -1 / (R * 0.3), kFar = -1 / (R * 1.2);
      for (let gy = 0; gy < gh; gy++) {
        const y = (gy + 0.5) * c, sky = 0.012 + 0.035 * (y / H) ** 1.5, dy2 = (y - my) ** 2;
        for (let gx = 0; gx < gw; gx++) {
          const i = gy * gw + gx, x = (gx + 0.5) * c;
          let li = -1, b, cloudy = true;
          for (let k = 3; k >= 0; k--) if (y >= tops[k][gx]) { li = k; break; }
          if (ruin[i] >= 0 && li < 3) {
            b = ruin[i];
            cloudy = false;
          } else if (li >= 0) {
            const dy = y - tops[li][gx];
            b = LAYERS[li].b * (0.55 + 0.45 * Math.exp(dy * kHaze));
            if (dy < H * 0.4) b += clamp(slopes[li][gx] * 0.9, -0.1, 0.25) * Math.exp(dy * kShade);
            b *= 0.7 + 0.3 * Math.sin((x * 0.7 - y) * 0.32 + li); // a diagonal hatch, like an engraver's burin
            if (dy < c * 8) b = Math.max(b, 0.95 * Math.exp(dy * kCrest) * moonward[gx]); // the lit crest: a contour line
            cloudy = li === 0;
          } else {
            const dm = Math.sqrt((x - mx) ** 2 + dy2);
            if (dm < R) {
              const sea = tex[(((y - my) / R) * 20 + 32 | 0) * NX + ((((x - mx) / R) * 60 + 128) | 0)];
              b = R - dm < c * 1.2 ? 0.95 : 0.92 - 0.3 * (dm / R) ** 2 - 0.42 * smooth(0.45, 0.8, sea);
            } else {
              b = sky;
              if (dm < R * 8) b += 0.3 * Math.exp((dm - R) * kNear) + 0.08 * Math.exp((dm - R) * kFar);
              if (y < H * 0.55 && stars() < 0.0035) b = 0.6 + 0.4 * stars();
            }
          }
          b *= calm[gx];
          bS[i] = b;
          thr[i] = BAYER[(gy & 7) * 8 + (gx & 7)];
          lit[i] = b > thr[i] ? tone(b) : 0;
          if (cloudy && y > bandTop && y < bandBot) inBand.push(i);
        }
      }

      // The cloud band: everything a frame needs, worked out once.
      const m = inBand.length;
      band = { m, idx: Int32Array.from(inBand), uA: new Float32Array(m), uB: new Float32Array(m), ra0: new Int32Array(m), ra1: new Int32Array(m), fa: new Float32Array(m), rb0: new Int32Array(m), rb1: new Int32Array(m), fb: new Float32Array(m), env: new Float32Array(m), cb: new Float32Array(m) };
      const gauss = (v, at, s) => Math.exp(-(((v - at) / s) ** 2));
      for (let j = 0; j < m; j++) {
        const i = inBand[j], gx = i % gw, x = (gx + 0.5) * c, y = (((i / gw) | 0) + 0.5) * c, v = (y - bandTop) / (bandBot - bandTop);
        band.uA[j] = (x / (W * 2.5)) * NX;
        band.uB[j] = (x / (W * 1.4)) * NX + 90;
        const va = v * (NY - 1), vb = (v * NY * 0.8 + 23) % NY;
        band.ra0[j] = (va | 0) * NX; band.ra1[j] = Math.min(NY - 1, (va | 0) + 1) * NX; band.fa[j] = va - (va | 0);
        band.rb0[j] = (vb | 0) * NX; band.rb1[j] = (((vb | 0) + 1) % NY) * NX; band.fb[j] = vb - (vb | 0);
        band.env[j] = Math.max(gauss(v, 0.3, 0.13), 0.85 * gauss(v, 0.72, 0.12)) * (y > tops[0][gx] ? 0.5 : 1);
        band.cb[j] = (0.22 + 0.45 * Math.exp(-Math.max(0, Math.sqrt((x - mx) ** 2 + (y - my) ** 2) - R * 0.6) / (R * 1.4))) * calm[gx];
      }

      // The shimmer: a few dots outside the band that sit close to their threshold, away from the middle.
      const q = rng(91), want = Math.round(clamp(N / 300, 150, 600)), pick = [];
      let seen = 0;
      for (let i = 0; i < N; i++) {
        const gx = i % gw, y = (((i / gw) | 0) + 0.5) * c;
        if ((y > bandTop && y < bandBot) || calm[gx] < 0.7 || bS[i] < 0.05 || Math.abs(bS[i] - thr[i]) > 0.045) continue;
        seen++;
        if (pick.length < want) pick.push(i);
        else if (q() * seen < want) pick[(q() * want) | 0] = i;
      }
      shim = { idx: Int32Array.from(pick), f: Float32Array.from(pick, () => 0.6 + 1.4 * q()), ph: Float32Array.from(pick, () => q() * TAU) };
      const cap = m + pick.length;
      out = { erase: new Int32Array(cap), dots: [null, new Int32Array(cap), new Int32Array(cap), new Int32Array(cap)], n: [0, 0, 0, 0] };
    },
    paint(g) {
      g.fillStyle = bg;
      g.fillRect(0, 0, W, H);
      g.fillStyle = ink;
      for (let t = 1; t <= 3; t++) {
        g.globalAlpha = ALPHA[t];
        g.beginPath();
        for (let i = 0; i < lit.length; i++) if (lit[i] === t) g.rect((i % gw) * c, ((i / gw) | 0) * c, d, d);
        g.fill();
      }
      g.globalAlpha = 1;
    },
    frame(g, dt, fast) {
      const k = fast ? 2.6 : 1;
      offA += dt * 0.6 * k;
      offB += dt * 1.0 * k;
      sh += dt * k;
      const n = out.n;
      n[0] = n[1] = n[2] = n[3] = 0;
      // A cell that changes either gains a dot or loses its still one; the rest of the picture is already there.
      const put = (i, b) => {
        const t = b > thr[i] ? tone(b) : 0;
        if (t && !lit[i]) out.dots[t][n[t]++] = i;
        else if (!t && lit[i]) out.erase[n[0]++] = i;
      };
      const { m, idx, uA, uB, ra0, ra1, fa, rb0, rb1, fb, env, cb } = band;
      const oA = offA % NX, oB = offB % NX;
      for (let j = 0; j < m; j++) {
        let u = uA[j] + oA, x0 = u | 0, fx = u - x0;
        x0 %= NX;
        let x1 = x0 + 1 === NX ? 0 : x0 + 1, p = tex[ra0[j] + x0] + (tex[ra0[j] + x1] - tex[ra0[j] + x0]) * fx;
        const a = p + (tex[ra1[j] + x0] + (tex[ra1[j] + x1] - tex[ra1[j] + x0]) * fx - p) * fa[j];
        u = uB[j] + oB; x0 = u | 0; fx = u - x0; x0 %= NX;
        x1 = x0 + 1 === NX ? 0 : x0 + 1; p = tex[rb0[j] + x0] + (tex[rb0[j] + x1] - tex[rb0[j] + x0]) * fx;
        const nz = 0.62 * a + 0.38 * (p + (tex[rb1[j] + x0] + (tex[rb1[j] + x1] - tex[rb1[j] + x0]) * fx - p) * fb[j]);
        const cov = smooth(0.54, 0.7, nz) * env[j];
        if (cov < 0.02) continue;
        const i = idx[j], lum = cb[j] * (0.75 + 0.5 * smooth(0.62, 0.9, nz));
        put(i, bS[i] + (lum - bS[i]) * cov);
      }
      for (let j = 0; j < shim.idx.length; j++) put(shim.idx[j], bS[shim.idx[j]] + 0.05 * Math.sin(sh * shim.f[j] + shim.ph[j]));
      if (n[0]) {
        g.fillStyle = bg;
        g.beginPath();
        for (let j = 0; j < n[0]; j++) g.rect((out.erase[j] % gw) * c, ((out.erase[j] / gw) | 0) * c, c, c);
        g.fill();
      }
      g.fillStyle = ink;
      for (let t = 1; t <= 3; t++) {
        if (!n[t]) continue;
        const list = out.dots[t];
        g.globalAlpha = ALPHA[t];
        g.beginPath();
        for (let j = 0; j < n[t]; j++) g.rect((list[j] % gw) * c, ((list[j] / gw) | 0) * c, d, d);
        g.fill();
      }
      g.globalAlpha = 1;
    },
  };
}

const MAKERS = { orbix: orbixScene, sunset: sunsetScene, nebula: nebulaScene, aurora: auroraScene, dither: ditherScene };

// ---------------------------------------------------------------- fireworks
// Fireworks get their own layer over the whole window (above dialogs, under menus and toasts), drawn only while some
// are in the air, so a celebration is never hidden behind Settings and never costs anything at rest.

let fx = null, fxg = null, fxRaf = 0, fxLast = 0, fxT = 0, FW = 0, FH = 0, fdpr = 1;

function fxLayer() {
  if (!fx) {
    fx = document.createElement('canvas');
    fx.className = 'fireworks';
    fx.setAttribute('aria-hidden', 'true');
    fxg = fx.getContext('2d');
  }
  if (!fx.isConnected) document.body.append(fx);
  fdpr = Math.min(2, devicePixelRatio || 1);
  FW = innerWidth; FH = innerHeight;
  fx.width = Math.round(FW * fdpr);
  fx.height = Math.round(FH * fdpr);
}

function launch(palette) {
  if (!fx?.isConnected) fxLayer();
  // Over the workspace sheet's sides (never the sidebar or the side panel).
  const r = document.querySelector('.main')?.getBoundingClientRect();
  const left = r?.width ? r.left : 0, width = r?.width || FW;
  const side = Math.random() < 0.5 ? 0.05 + Math.random() * 0.17 : 0.78 + Math.random() * 0.17;
  rockets.push({ x: left + width * side, y0: FH + 4, y1: FH * (0.12 + Math.random() * 0.25), t0: fxT, dur: 0.75 + Math.random() * 0.3, palette });
  if (!fxRaf) (fxLast = performance.now()), (fxRaf = requestAnimationFrame(fxFrame));
}

function burst(x, y, palette) {
  const n = 70 + Math.round(Math.random() * 24);
  const col = palette[Math.floor(Math.random() * palette.length)], alt = palette[Math.floor(Math.random() * palette.length)];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n + (Math.random() - 0.5) * 0.08, v = 80 + Math.random() * 170;
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 1.2 + Math.random() * 0.7, c: i % 3 ? col : alt });
  }
}

function fxFrame(now) {
  const dt = Math.min(0.05, (now - fxLast) / 1000);
  fxLast = now;
  fxT += dt;
  const g = fxg;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, fx.width, fx.height);
  g.setTransform(fdpr, 0, 0, fdpr, 0, 0);
  rockets = rockets.filter((r) => {
    const k = (fxT - r.t0) / r.dur;
    if (k >= 1) return burst(r.x, r.y1, r.palette), false;
    const y = r.y0 + (r.y1 - r.y0) * (1 - (1 - k) ** 2);
    g.globalAlpha = 0.95;
    g.fillStyle = r.palette[0];
    g.fillRect(r.x - 1.2, y - 1.2, 2.4, 2.4);
    g.globalAlpha = 0.3;
    g.fillRect(r.x - 0.6, y, 1.2, 28);
    return true;
  });
  const drag = Math.pow(0.2, dt);
  g.lineWidth = 1.5;
  g.lineCap = 'round';
  sparks = sparks.filter((p) => {
    p.life += dt;
    if (p.life >= p.max) return false;
    p.vx *= drag; p.vy = p.vy * drag + 60 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    g.globalAlpha = (1 - p.life / p.max) ** 1.4;
    g.strokeStyle = p.c;
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05); g.stroke();
    return true;
  });
  g.globalAlpha = 1;
  if (rockets.length || sparks.length) fxRaf = requestAnimationFrame(fxFrame);
  else (fxRaf = 0), fx.remove();
}

// ---------------------------------------------------------------- engine

function css(v, d) {
  return getComputedStyle(root).getPropertyValue(v).trim() || d;
}

/** The reading column's width: the message box on screen, or a default. */
function column() {
  const el = document.querySelector('.session:not([hidden]) .dock-col, .welcome:not([hidden]) .home-composer');
  return Math.max(760, el?.getBoundingClientRect().width || 860);
}

/**
 * The veil: the sheet colour over the reading column, soft at its edges. The narrower the open space beside the column, the stronger the veil, so a small window
 * keeps its text clear and the scene simply recedes.
 */
function paintVeil() {
  const g = sized(veil, W, H);
  const col = Math.min(W, column()), base = parseFloat(css('--scene-veil', '0.6')) || 0;
  g.clearRect(0, 0, W, H);
  if (!base) return;
  const side = (W - col) / 2;
  const strength = base + (0.9 - base) * clamp(1 - (side - 40) / 220, 0, 1);
  const bg = css('--bg', '#000');
  const lg = g.createLinearGradient(0, 0, W, 0);
  const a = clamp((side - 180) / W, 0, 0.5), b = clamp((side + 40) / W, a, 0.5);
  lg.addColorStop(0, 'rgba(0,0,0,0)');
  lg.addColorStop(a, 'rgba(0,0,0,0)');
  lg.addColorStop(b, '#000');
  lg.addColorStop(1 - b, '#000');
  lg.addColorStop(1 - a, 'rgba(0,0,0,0)');
  lg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = bg;
  g.globalAlpha = strength;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-in';
  g.globalAlpha = 1;
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);
}

function size(force) {
  if (!live) return;
  const r = host.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height), d = Math.min(2, devicePixelRatio || 1);
  if (!w || !h || (!force && w === W && h === H && d === dpr)) return;
  dpr = d;
  W = w; H = h;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  scene.setup();
  const g = sized(base, W, H);
  g.clearRect(0, 0, W, H);
  scene.paint(g);
  paintVeil();
  draw(0);
}

// Resizes come in bursts (dragging the sidebar, zooming): settle them into one repaint per frame.
let sizeQueued = 0;
const resized = () => {
  if (sizeQueued || !live) return;
  sizeQueued = requestAnimationFrame(() => {
    sizeQueued = 0;
    size();
    run();
  });
};

function draw(dt) {
  T += dt;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(base, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene.frame(ctx, dt, dt > 0 && busy());
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(veil, 0, 0);
}

function frame(now) {
  raf = 0;
  if (!live) return;
  const gap = document.hasFocus() ? 32 : 95;
  if (now - drawn >= gap) {
    draw(Math.min(0.1, (now - last) / 1000));
    last = drawn = now;
  }
  raf = requestAnimationFrame(frame);
}

function run() {
  if (raf) cancelAnimationFrame(raf), (raf = 0);
  if (!live || !W) return;
  if (!animated() || document.hidden) return draw(0);
  last = drawn = performance.now();
  raf = requestAnimationFrame(frame);
}

function start(name) {
  host = document.querySelector('.main');
  if (!host) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'backdrop';
    canvas.setAttribute('aria-hidden', 'true');
    ctx = canvas.getContext('2d');
  }
  if (!ctx) return;
  if (canvas.parentNode !== host) host.prepend(canvas);
  current = name;
  scene = MAKERS[name]();
  live = true;
  T = 8; // a still frame shows the scene already in motion, not at its first instant
  W = H = 0;
  ro ||= new ResizeObserver(resized);
  ro.observe(host);
  size(true);
  run();
}

function stop() {
  live = false;
  current = '';
  if (raf) cancelAnimationFrame(raf), (raf = 0);
  ro?.disconnect();
  canvas?.remove();
  W = H = 0;
}

/** Fireworks at the sides of the window, in the scene's colours (or the theme's accent outside a scene). */
function celebrate(force) {
  if (still.matches || document.hidden || (!force && (!live || !animated()))) return;
  const palette = live ? scene.sparks : [css('--accent', '#3DF28C'), css('--fg', '#FFFFFF'), css('--live', '#7CC4FF')];
  for (let i = 0; i < 3; i++) setTimeout(() => launch(palette), i * 380);
}

export function initBackdrop() {
  const sync = () => {
    const name = SCENES.includes(root.dataset.theme) ? root.dataset.theme : '';
    if (name === current) return live && size(true); // same scene, new colours (a theme's light/dark follow)
    if (current) stop();
    if (name) start(name);
  };
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  // The Wide reading column changes where the veil and the lily pads go.
  let wide = root.classList.contains('wide');
  new MutationObserver(() => {
    if (root.classList.contains('wide') === wide) return;
    wide = !wide;
    if (live) size(true);
  }).observe(root, { attributes: true, attributeFilter: ['class'] });
  addEventListener('resize', resized);
  document.addEventListener('visibilitychange', run);
  still.addEventListener('change', run);
  on('prefs', run);
  // Home and a conversation have different reading columns: repaint the veil when switching.
  on('active', () => live && (paintVeil(), run()));
  const was = new Map();
  on('tab:status', (tab) => {
    const before = was.get(tab.id);
    was.set(tab.id, tab.streaming);
    if (!before || tab.streaming || tab.dead) return;
    const end = tab.messages[tab.messages.length - 1];
    if (end?.role === 'assistant' && (end.stopReason === 'error' || end.stopReason === 'aborted')) return;
    celebrate();
  });
  sync();
}

/** Settings → Appearance → Preview the finish: fire the celebration now, even with scene motion off. */
export function previewCelebration() {
  celebrate(true);
}
