// Scene themes: a living picture behind the workspace sheet. Each scene theme (see SCENES) paints a still layer once
// per size, then animates a few things on top: a planet's ring, a neon grid, koi, an aurora, a halftone sun. While an
// agent works, the scene moves a little faster; when a turn finishes cleanly, fireworks go up at the sides.
// A soft veil of the sheet colour sits over the reading column, so text always reads first.
// Runs at 30 frames a second in front (about 10 behind other windows), stops while the window is hidden, and is one
// still frame under reduced motion or when Settings → Appearance → Animate scenes is off.
import { S, on } from './store.js';

export const SCENES = ['orbix', 'sunset', 'koi', 'aurora', 'dusk'];

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
const animated = () => !still.matches && S.ui?.sceneMotion !== false;

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
    sparks: ['#D4FF4F', '#E4E2FF', '#9C8BFF', '#FFFFFF'],
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
        g.fillStyle = lit ? '#D4FF4F' : '#E4E2FF';
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

// ---------------------------------------------------------------- Koi: pixel koi turning slowly in a light pond

function koiScene() {
  const C = 10; // mosaic cell
  let fish = [], ripples = [], nextRipple = 2, t = 0, pads = [];
  const O = '#F2643A', R = '#E2402A', Wh = '#FFFFFF', Y = '#F7B53B', K = '#2E2B33';
  const PATTERNS = [
    { body: [O, O, Wh, O, O, Wh, Wh, O, Wh, Wh], fin: '#F7A07F', tail: '#F7A07F' },
    { body: [Wh, R, R, Wh, Wh, R, Wh, Wh, R, Wh], fin: '#F4C9BE', tail: '#F4C9BE' },
    { body: [Y, Y, Y, Wh, Y, Y, Wh, Y, Y, Wh], fin: '#F9D58C', tail: '#F9D58C' },
    { body: [K, Wh, O, K, Wh, Wh, O, K, Wh, Wh], fin: '#C9C4D0', tail: '#C9C4D0' },
    { body: [O, Wh, Wh, O, Wh, O, Wh, Wh, O, Wh], fin: '#F7A07F', tail: '#F7A07F' },
  ];
  const WIDTH = [2, 3, 4, 4, 4, 3, 3, 2, 2, 1];
  const pos = (f, tt) => [f.cx + f.ax * Math.sin(f.w * tt + f.ph), f.cy + f.ay * Math.sin(2 * (f.w * tt + f.ph))];
  const snap = (v) => Math.round(v / C) * C;
  function cell(g, x, y, col) {
    g.fillStyle = col;
    g.fillRect(snap(x), snap(y), C - 1, C - 1);
  }
  function drawFish(g, f, shadow) {
    const segs = [];
    for (let k = 0; k < WIDTH.length + 1; k++) segs.push(pos(f, t - k * f.gap));
    for (let k = 0; k < WIDTH.length; k++) {
      const [x, y] = segs[k];
      const [ax, ay] = segs[Math.max(0, k - 1)], [bx, by] = segs[k + 1];
      let dx = ax - bx, dy = ay - by;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      const nx = -dy, ny = dx, w = WIDTH[k];
      const col = shadow || f.pat.body[k];
      for (let j = 0; j < w; j++) {
        const o = (j - (w - 1) / 2) * C;
        cell(g, x + nx * o + (shadow ? 5 : 0), y + ny * o + (shadow ? 7 : 0), col);
      }
      if (k === 2) for (const side of [-1, 1]) cell(g, x + nx * side * C * 2.5 - dx * C * 0.5 + (shadow ? 5 : 0), y + ny * side * C * 2.5 - dy * C * 0.5 + (shadow ? 7 : 0), shadow || f.pat.fin);
      if (k === WIDTH.length - 1) for (const side of [-1, 1]) cell(g, x - dx * C + nx * side * C + (shadow ? 5 : 0), y - dy * C + ny * side * C + (shadow ? 7 : 0), shadow || f.pat.tail);
    }
  }
  function pad(g, x, y, r, notch, flower) {
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++) {
        const d = Math.hypot(i, j);
        if (d > r + 0.3) continue;
        const a = Math.atan2(j, i);
        if (d > 0.8 && Math.abs(((a - notch + Math.PI) % TAU) - Math.PI) < 0.35) continue;
        g.fillStyle = d > r - 1 ? '#3E9A55' : (i + j) % 3 === 0 ? '#79C77E' : '#6BBE72';
        g.fillRect(x + i * C, y + j * C, C - 1, C - 1);
      }
    if (flower)
      for (const [i, j, c] of [[0, -1, '#FF8FB1'], [-1, 0, '#FF8FB1'], [1, 0, '#FF8FB1'], [0, 1, '#FF8FB1'], [0, 0, '#FFE07A'], [-1, -1, '#FFC2D4'], [1, -1, '#FFC2D4']])
        (g.fillStyle = c), g.fillRect(x + (i + 1) * C, y + (j - 1) * C, C - 1, C - 1);
  }
  return {
    sparks: ['#F2643A', '#0F8C82', '#F7B53B', '#E8452C'],
    setup() {
      const r = rng(5);
      fish = PATTERNS.map((pat, i) => ({
        pat,
        cx: W * [0.2, 0.8, 0.45, 0.72, 0.15][i], cy: H * [0.35, 0.7, 0.85, 0.2, 0.75][i],
        ax: W * (0.12 + r() * 0.1), ay: H * (0.1 + r() * 0.08),
        w: 0.11 + r() * 0.06, ph: r() * TAU, gap: 0,
      }));
      for (const f of fish) f.gap = (C * 1.05) / Math.max(30, f.ax * f.w);
      // Lily pads float in the open water beside the reading column, never under its text.
      const side = Math.max(0, (W - Math.min(W, column())) / 2);
      pads = [[0, 0.2, 4, 0.6, true], [1, 0.3, 5, 2.4, false], [1, 0.84, 5, 4, true], [0, 0.82, 3, 1.2, false], [1, 0.58, 3, 5, false], [0, 0.5, 2, 2, false]]
        .map(([edge, y, r, n, fl], i) => [edge ? W - side / 2 + ((i % 2) - 0.5) * side * 0.3 : side / 2 + ((i % 2) - 0.5) * side * 0.3, y, r, n, fl]);
    },
    paint(g) {
      const water = g.createLinearGradient(0, 0, W, H);
      water.addColorStop(0, '#E2F7F3');
      water.addColorStop(0.55, '#BFEAE6');
      water.addColorStop(1, '#94D8D8');
      g.fillStyle = water;
      g.fillRect(0, 0, W, H);
      const r = rng(9);
      for (let i = 0; i < 7; i++) {
        const x = r() * W, y = r() * H, rr = 80 + r() * 160;
        const c = g.createRadialGradient(x, y, 0, x, y, rr);
        c.addColorStop(0, 'rgba(255,255,255,.35)');
        c.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = c;
        g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
      }
    },
    frame(g, dt, fast) {
      t += dt * (fast ? 2 : 1);
      if (T > nextRipple) {
        ripples.push({ x: Math.random() * W, y: Math.random() * H, t0: T });
        nextRipple = T + 1.6 + Math.random() * 2.4;
      }
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 1.2;
      ripples = ripples.filter((rp) => {
        const k = (T - rp.t0) / 3;
        if (k >= 1) return false;
        g.globalAlpha = (1 - k) * 0.7;
        g.beginPath(); g.ellipse(rp.x, rp.y, 8 + k * 70, (8 + k * 70) * 0.55, 0, 0, TAU); g.stroke();
        return true;
      });
      g.globalAlpha = 1;
      for (const f of fish) drawFish(g, f, 'rgba(10,80,90,.13)');
      for (const f of fish) drawFish(g, f);
      for (const [x, y, r, n, fl] of pads) pad(g, snap(x), snap(y * H), r, n, fl);
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

// ---------------------------------------------------------------- Dusk: a halftone sun breathing in warm dots

function duskScene() {
  let dots = [], Rs, cx, cy;
  const BANDS = ['#FFD36E', '#FFB054', '#FF8A4C', '#FF6A45', '#F24F5C', '#DE3D74', '#C2348A'];
  return {
    sparks: ['#FFD36E', '#FF6A45', '#DE3D74', '#FFFFFF'],
    setup() {
      Rs = clamp(Math.min(W, H) * 0.42, 170, 400);
      cx = W - Rs * 0.5;
      cy = H - Rs * 0.4;
      const gap = 12;
      dots = BANDS.map(() => []);
      for (let y = cy - Rs * 1.3; y < Math.min(H + gap, cy + Rs * 1.3); y += gap)
        for (let x = cx - Rs * 1.3; x < Math.min(W + gap, cx + Rs * 1.3); x += gap) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > Rs * 1.25) continue;
          const band = clamp(Math.floor(((y - (cy - Rs)) / (2 * Rs)) * BANDS.length), 0, BANDS.length - 1);
          dots[band].push(x, y, d);
        }
    },
    paint(g) {
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#100D12');
      sky.addColorStop(1, '#1B1218');
      g.fillStyle = sky;
      g.fillRect(0, 0, W, H);
      const glow = g.createRadialGradient(cx, cy, Rs * 0.3, cx, cy, Rs * 1.9);
      glow.addColorStop(0, 'rgba(255,110,70,.16)');
      glow.addColorStop(1, 'rgba(255,110,70,0)');
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      // a fading dot screen in the far corner, for depth
      g.fillStyle = '#F2C7A0';
      for (let y = 6; y < H * 0.4; y += 14)
        for (let x = 6; x < W * 0.3; x += 14) {
          const f = 1 - Math.hypot(x / (W * 0.3), y / (H * 0.4));
          if (f <= 0) continue;
          g.globalAlpha = 0.09 * f;
          g.beginPath(); g.arc(x, y, 2.4 * f + 0.4, 0, TAU); g.fill();
        }
      g.globalAlpha = 1;
    },
    frame(g, dt, fast) {
      const sp = fast ? 3 : 1.1;
      BANDS.forEach((col, b) => {
        const a = dots[b];
        g.fillStyle = col;
        g.beginPath();
        for (let i = 0; i < a.length; i += 3) {
          const d = a[i + 2];
          const core = d < Rs ? 1 - (d / Rs) * 0.55 : Math.max(0, 1 - (d - Rs) / (Rs * 0.25)) * 0.35;
          const r = 5.2 * core * (0.78 + 0.22 * Math.sin(d * 0.03 - T * sp));
          if (r < 0.4) continue;
          g.moveTo(a[i] + r, a[i + 1]);
          g.arc(a[i], a[i + 1], r, 0, TAU);
        }
        g.fill();
      });
    },
  };
}

const MAKERS = { orbix: orbixScene, sunset: sunsetScene, koi: koiScene, aurora: auroraScene, dusk: duskScene };

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
  const palette = live ? scene.sparks : [css('--accent', '#D4FF4F'), css('--fg', '#FFFFFF'), css('--live', '#7CC4FF')];
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
