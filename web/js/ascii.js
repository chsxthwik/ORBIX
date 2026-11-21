// ASCII effects: the orbit on Home, the COM-X mark in About, the spinner while the agent works, and small art for
// empty panels. All of it is decoration: hidden from screen readers, never behind text, it sleeps while off screen,
// and under reduced motion (Windows' setting or Settings → Appearance → Screen reader mode) it shows one still frame.
import { h } from './dom.js';

const motionOff = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = { get matches() {
  const root = document.documentElement;
  return motionOff.matches || root.classList.contains('sr') || root.dataset.motion === 'off';
} };
const TAU = Math.PI * 2;
// 4x4 ordered dither, so shading steps between two characters instead of banding.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const hash = (i) => {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** The character from `ramp` for brightness v (0-1), dithered by the cell's place so gradients do not band. */
const shade = (ramp, v, c, r, lo = 1, spread = 0.7) => ramp.charCodeAt(clamp(Math.round(v * (ramp.length - 1) + BAYER[(c & 3) + (r & 3) * 4] * spread), lo, ramp.length - 1));

/**
 * A grid of characters on a canvas, and the loop that draws it: `compose(time, dt, still)` fills the cells each frame
 * (cell = character code, alpha = strength, sig = drawn in the signal colour). The picture fades in from its centre.
 * The owner destroys the canvas with its view; hidden canvases and still frames have no animation loop.
 */
function charCanvas({ cols, rows, font, lineH, cls }) {
  const cw = font * 0.6;
  const W = cols * cw;
  const H = rows * lineH;
  const canvas = h('canvas', { class: cls, width: Math.round(W), height: Math.round(H), 'aria-hidden': 'true' });
  // Width may shrink (max-width: 100%); height follows the aspect ratio so the art is never squashed.
  Object.assign(canvas.style, { width: `${W}px`, height: 'auto', aspectRatio: `${W} / ${H}` });
  const ctx = canvas.getContext('2d', { alpha: true });
  const N = cols * rows;
  const cell = new Uint8Array(N);
  const alpha = new Float32Array(N);
  const sig = new Uint8Array(N);
  // When each cell settles during the intro: its distance from the centre, a little jittered so the front is ragged.
  const order = new Float32Array(N);
  const far = Math.hypot(W / 2, H / 2);
  for (let i = 0; i < N; i++) order[i] = (Math.hypot(((i % cols) + 0.5) * cw - W / 2, (Math.floor(i / cols) + 0.5) * lineH - H / 2) / far) * 0.82 + hash(i + 7) * 0.18;
  const stop = new AbortController();

  const g = {
    canvas, W, H, cw, cols, rows, cell, alpha, sig, signal: stop.signal,
    destroy: () => stop.abort(),
    active: () => false,
    /** Mark a cell. With `keep`, a stronger plain mark already there wins. */
    put(c, r, ch, al, s = 0, keep = false) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) return;
      const i = r * cols + c;
      if (keep && cell[i] && alpha[i] > al && !s) return;
      cell[i] = ch;
      alpha[i] = al;
      sig[i] = s;
    },
    start(compose) {
      if (!ctx) return;
      let visible = false;
      let frame = 0;
      let dirty = true;
      let last = 0;
      let elapsed = 0;
      let colors = null;
      let dpr = 0;
      const paint = (still) => {
        const ratio = Math.min(2, devicePixelRatio || 1);
        if (ratio !== dpr) {
          dpr = ratio;
          canvas.width = Math.round(W * dpr);
          canvas.height = Math.round(H * dpr);
        }
        if (!colors) {
          const css = getComputedStyle(document.documentElement);
          const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
          colors = [get('--fg', '#888'), get('--live', '#4c4')];
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.font = `${font}px "Geist Mono Variable", Consolas, monospace`;
        ctx.textBaseline = 'middle';
        const p = still ? 1 : Math.min(1, elapsed / 560);
        const front = (1 - (1 - p) ** 2) * 1.25; // eases out: quick at the centre, gentle at the edge
        let fill = '';
        for (let i = 0; i < N; i++) {
          if (!cell[i] || order[i] > front) continue;
          const nf = colors[sig[i]];
          if (nf !== fill) ctx.fillStyle = fill = nf;
          ctx.globalAlpha = alpha[i] * Math.min(1, (front - order[i]) * 7);
          ctx.fillText(String.fromCharCode(cell[i]), (i % cols) * cw, (Math.floor(i / cols) + 0.5) * lineH);
        }
        ctx.globalAlpha = 1;
      };
      const inView = () => visible && canvas.isConnected && !document.hidden && !stop.signal.aborted;
      g.active = () => inView() && !reduced.matches;
      const pause = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
      };
      const schedule = () => {
        if (!inView()) return pause();
        if (!frame && (dirty || !reduced.matches)) frame = requestAnimationFrame(tick);
      };
      function tick(time) {
        frame = 0;
        if (!inView()) return;
        const still = reduced.matches;
        if (dirty || (!still && time - last >= 32)) {
          const dt = still || !last ? 0 : Math.min(0.1, (time - last) / 1000);
          last = time;
          if (!still) elapsed += dt * 1000 || 16;
          cell.fill(0);
          compose(still ? 0 : elapsed, dt, still);
          paint(still);
          dirty = false;
        }
        schedule();
      }
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        schedule();
      });
      observer.observe(canvas);
      const invalidate = () => {
        colors = null;
        dirty = true;
        schedule();
      };
      const theme = new MutationObserver(invalidate);
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-mode', 'data-motion'] });
      const options = { signal: stop.signal };
      motionOff.addEventListener('change', invalidate, options);
      document.addEventListener('visibilitychange', schedule, options);
      addEventListener('resize', invalidate, options);
      stop.signal.addEventListener('abort', () => {
        pause();
        observer.disconnect();
        theme.disconnect();
      }, { once: true });
    },
  };
  return g;
}

const RAMP = ' .:-=+*#%@';
const TRAIL = '@Oo*+:..';

/**
 * A planet and a tilted orbit drawn in characters (the ORBIX mark as a little live system). The planet turns under a
 * light that follows the pointer; its dark side still shows, with a rim where it meets space, and a thin atmosphere
 * glows on the lit edge. The node lights the planet as it passes in front, now and then a meteor crosses, and typing
 * nearby gives the orbit a push that fades.
 */
export function asciiOrbit({ cols = 64, rows = 15, font = 10, lineH = 12 } = {}) {
  const g = charCanvas({ cols, rows, font, lineH, cls: 'ascii-orbit' });
  const { W, H, cw, put } = g;
  const R = H * 0.34;
  const a = Math.min(W * 0.47, R * 2.1);
  const b = a * 0.3;
  const TILT = (-24 * Math.PI) / 180;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const STEPS = 420;
  const HALO = cw * 1.5; // how far the atmosphere reaches past the edge

  // A few fixed stars, the same on every launch, kept clear of the planet.
  const stars = [];
  for (let i = 0; stars.length < Math.round((cols * rows) / 60) && i < 400; i++) {
    const c = Math.floor(hash(i * 3 + 1) * cols);
    const r = Math.floor(hash(i * 3 + 2) * rows);
    const dx = (c + 0.5) * cw - W / 2;
    const dy = (r + 0.5) * lineH - H / 2;
    if (dx * dx + dy * dy > (R + 12) ** 2) stars.push({ c, r, p: hash(i * 3 + 3) * TAU, s: 0.5 + hash(i * 7) * 1.4, ch: i % 5 ? 46 : 43 });
  }

  let node = 0.6;
  let spin = 0;
  let energy = 0;
  let light = [-0.34, -0.4];
  let aim = [-0.34, -0.4];

  const inSphere = (x, y) => x * x + y * y < R * R;
  const orbitAt = (t) => {
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    return [ex * cosT - ey * sinT, ex * sinT + ey * cosT];
  };
  const toCell = (x, y) => [Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH)];
  /** The character that follows the ring's slope where it crosses a cell, so the ring reads as one line. */
  const ringChar = (t, y) => {
    const ex = -a * Math.sin(t);
    const ey = b * Math.cos(t);
    const dx = (ex * cosT - ey * sinT) / cw;
    const dy = (ex * sinT + ey * cosT) / lineH;
    if (Math.abs(Math.cos(t)) > 0.992) return Math.cos(t) > 0 ? 41 : 40; // ) and ( where the ring turns back
    const slope = Math.abs(dx) < 1e-6 ? 99 : dy / dx;
    if (slope > 0.5) return 92; // \
    if (slope < -0.5) return 47; // /
    const fy = (y + H / 2) / lineH;
    return fy - Math.floor(fy) > 0.62 ? 95 : 45; // _ low in the cell, - otherwise: no stair steps
  };
  const ring = (near) => {
    for (let k = 0; k < STEPS; k++) {
      const t = (k / STEPS) * TAU;
      if (Math.sin(t) >= 0 !== near) continue;
      const [x, y] = orbitAt(t);
      if (!near && inSphere(x, y)) continue; // the far side passes behind the planet
      put(...toCell(x, y), ringChar(t, y), near ? 0.92 : 0.4, 1);
    }
  };
  /** A meteor every nine seconds or so, at a different place each time; it streaks down and to the left. */
  const meteor = (time) => {
    const n = Math.floor(time / 9000);
    const u = (time - n * 9000 - hash(n + 11) * 5000) / 700;
    if (u < 0 || u > 1) return;
    const x0 = W * (0.65 * hash(n * 7 + 1) - 0.2); // from the centre, like every point here
    const y0 = H * (0.25 * hash(n * 5 + 3) - 0.5) - lineH;
    const len = W * 0.4;
    for (let k = 0; k < 6; k++) {
      const d = len * u - k * cw * 1.2;
      if (d < 0) break;
      put(...toCell(x0 - d * 0.88, y0 + d * 0.47), k ? (k < 3 ? 45 : 46) : 42, (k ? 0.5 - k * 0.07 : 0.8) * Math.sin(Math.PI * u) + 0.1);
    }
  };

  function compose(time, dt) {
    node = (node + dt * (0.65 + energy * 2.4)) % TAU;
    spin = (spin + dt * (0.22 + energy * 0.5)) % TAU;
    energy *= Math.exp(-dt * 1.1);
    const k = 1 - 0.08 ** (dt * 3); // easing that does not depend on the frame rate
    light = [light[0] + (aim[0] - light[0]) * k, light[1] + (aim[1] - light[1]) * k];

    for (const s of stars) {
      const v = 0.5 + 0.5 * Math.sin(time * 0.001 * s.s + s.p);
      put(s.c, s.r, s.ch, 0.07 + 0.3 * v * v);
    }
    if (time) meteor(time);
    ring(false);
    const [lx, ly] = light;
    const lz = Math.sqrt(Math.max(0.05, 1 - lx * lx - ly * ly));
    const hl = Math.hypot(lx, ly, lz + 1) || 1; // half vector between the light and the viewer
    const [nx0, ny0] = orbitAt(node);
    const nodeFront = Math.sin(node) >= 0;
    for (let r = 0; r < g.rows; r++) {
      const cy = (r + 0.5) * lineH - H / 2;
      if (Math.abs(cy) > R + HALO) continue;
      for (let c = 0; c < g.cols; c++) {
        const cx = (c + 0.5) * cw - W / 2;
        if (Math.abs(cx) > R + HALO) continue;
        let cov = 0; // four samples per cell soften the edge
        for (let s = 0; s < 4; s++) if (inSphere(cx + (s & 1 ? 0.25 : -0.25) * cw, cy + (s & 2 ? 0.25 : -0.25) * lineH)) cov++;
        const len = Math.hypot(cx, cy);
        if (!cov) {
          // The atmosphere: a faint glow just past the lit edge.
          const facing = (cx * lx + cy * ly) / (len * Math.hypot(lx, ly));
          const glow = Math.max(0, facing) * (1 - (len - R) / HALO);
          if (glow > 0.12) put(c, r, glow > 0.45 ? 58 : 46, 0.1 + 0.4 * glow, 1);
          continue;
        }
        const q = len > R * 0.985 ? (R * 0.985) / len : 1; // edge cells shade from a point just inside the limb
        const nx = (cx * q) / R;
        const ny = (cy * q) / R;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = Math.max(0, nx * lx + ny * ly + nz * lz);
        const lon = Math.atan2(nx, nz) + spin;
        const lat = Math.asin(clamp(ny, -1, 1));
        const land = Math.sin(lon * 3 + Math.sin(lat * 5)) * Math.cos(lat * 2.5) + 0.5 * Math.sin(lon * 7 + lat * 3) > 0.12;
        const spec = Math.max(0, (nx * lx + ny * ly + nz * (lz + 1)) / hl) ** 28 * 0.35;
        const rim = (1 - nz) ** 2 * 0.34; // the edge catches a little light, so the dark side still has an outline
        // The node, when it is in front, lights the face nearest to it.
        const near = nodeFront ? Math.max(0, 1 - Math.hypot(cx - nx0, cy - ny0) / (R * 0.75)) ** 2 : 0;
        const v = Math.min(1, ((0.2 + 0.8 * lit) * (land ? 0.95 : 0.58) + spec + rim + near * 0.4) * (0.55 + 0.1125 * cov));
        put(c, r, shade(RAMP, v, c, r), 0.24 + 0.74 * v, near > 0.42 ? 1 : 0);
      }
    }
    ring(true); // the near side passes in front of the planet
    // The node and its trail, which stretches when the orbit is pushed. Behind the planet they are hidden.
    for (let j = TRAIL.length - 1; j >= 0; j--) {
      const t = node - j * 0.07 * (1 + energy * 0.8);
      const [x, y] = orbitAt(t);
      if (Math.sin(t) < 0 && inSphere(x, y)) continue;
      put(...toCell(x, y), TRAIL.charCodeAt(j), 1 - (j / TRAIL.length) * 0.72, 1);
    }
  }
  g.start(compose);

  {
    let frame = 0;
    let px = 0, py = 0;
    addEventListener('pointermove', (e) => {
      if (!g.active()) return;
      px = e.clientX;
      py = e.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!g.active()) return;
        const box = g.canvas.getBoundingClientRect();
        if (box.width) aim = [clamp((px - (box.left + box.width / 2)) / 600, -0.55, 0.55), clamp((py - (box.top + box.height / 2)) / 400, -0.55, 0.55)];
      });
    }, { passive: true, signal: g.signal });
    g.signal.addEventListener('abort', () => { if (frame) cancelAnimationFrame(frame); }, { once: true });
    // The light settles back when the pointer leaves the window.
    document.documentElement.addEventListener('pointerleave', () => (aim = [-0.34, -0.4]), { signal: g.signal });
    // Typing a task gives the orbit a push.
    addEventListener('input', (e) => {
      if (g.active() && e.target?.matches?.('textarea.c-ta')) energy = Math.min(1, energy + 0.16);
    }, { passive: true, signal: g.signal });
  }
  return { el: g.canvas, destroy: g.destroy };
}

/**
 * The COM-X mark in characters: a faint ring, a solid X, and the signal arc travelling round the ring with a fading
 * tail. A light sweeps across the X now and then, and pointing at the mark hurries the arc. Under reduced motion the
 * arc holds where the logo has it (top right).
 */
export function asciiComx({ cols = 30, rows = 14, font = 10, lineH = 12 } = {}) {
  const g = charCanvas({ cols, rows, font, lineH, cls: 'ascii-comx' });
  const { W, H, cw, put } = g;
  const R = Math.min(W, H) * 0.43; // the ring, in pixels, so it stays round on 6 x 12 cells
  const S = R * 0.42; // half the X's diagonal, as in the logo (28 of a 68 ring)
  const T = R * 0.13; // half the X's stroke
  const ARC = 1.1; // the logo's arc spans about 63 degrees
  const HOME = (-73 * Math.PI) / 180; // where the logo's arc starts
  const DENSE = ' .:+*#%@';
  let head = HOME + ARC;
  let speed = 0.9;
  let hover = false;

  const toCell = (x, y) => [Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH)];
  /** The character that follows the ring's tangent where it crosses a cell. */
  const ringChar = (t, y) => {
    const dx = (-Math.sin(t) * R) / cw;
    const dy = (Math.cos(t) * R) / lineH;
    const slope = Math.abs(dx) < 1e-6 ? 99 : dy / dx;
    if (Math.abs(slope) > 2.2) return 124; // |
    if (slope > 0.45) return 92; // \
    if (slope < -0.45) return 47; // /
    const fy = (y + H / 2) / lineH;
    return fy - Math.floor(fy) > 0.62 ? 95 : 45; // _ or -
  };
  const segDist = (px, py, ax, ay, bx, by) => {
    const vx = bx - ax;
    const vy = by - ay;
    const k = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0, 1);
    return Math.hypot(px - ax - vx * k, py - ay - vy * k);
  };
  const xDist = (x, y) => Math.min(segDist(x, y, -S, -S, S, S), segDist(x, y, S, -S, -S, S));
  // The ring as a one-character line: where it is steep (in cell units) it is placed row by row, where it is flat
  // column by column, so no row gets a doubled slash and the top and bottom have no stray dashes.
  const RING = [];
  {
    const taken = new Set();
    const add = (x, y) => {
      const t = Math.atan2(y, x);
      const [c, r] = toCell(x, y);
      if (c < 0 || r < 0 || c >= cols || r >= rows || taken.has(r * cols + c)) return;
      taken.add(r * cols + c);
      RING.push({ c, r, t: (t + TAU) % TAU, ch: ringChar(t, y) });
    };
    const steep = (x, y) => Math.abs(x / lineH / ((y || 1e-6) / cw)) >= 1; // |dy/dx| in cells, from the tangent
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * lineH - H / 2;
      if (Math.abs(y) > R) continue;
      const x = Math.sqrt(R * R - y * y);
      for (const sx of [x, -x]) if (steep(sx, y)) add(sx, y);
    }
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cw - W / 2;
      if (Math.abs(x) > R) continue;
      const y = Math.sqrt(R * R - x * x);
      for (const sy of [y, -y]) if (!steep(x, sy)) add(x, sy);
    }
  }

  function compose(time, dt, still) {
    speed += ((hover ? 3.2 : 0.9) - speed) * (1 - 0.05 ** dt);
    head = still ? HOME + ARC : (head + dt * speed) % TAU;
    for (const p of RING) put(p.c, p.r, p.ch, 0.34, 0, true);
    // The X: four samples per cell give a soft edge; a light sweeps along the diagonal every few seconds.
    const sweep = ((time / 1000) % 4.2) / 4.2;
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * lineH - H / 2;
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cw - W / 2;
        if (Math.abs(cx) > S + T + cw || Math.abs(cy) > S + T + lineH) continue;
        let cov = 0;
        for (let s = 0; s < 4; s++) if (xDist(cx + (s & 1 ? 0.25 : -0.25) * cw, cy + (s & 2 ? 0.25 : -0.25) * lineH) < T) cov++;
        if (!cov) continue;
        const along = (cx + cy) / (4 * S) + 0.5; // 0 at top left, 1 at bottom right
        const glint = time ? Math.max(0, 1 - Math.abs(along - (sweep * 1.8 - 0.4)) * 5) : 0;
        const v = Math.min(1, 0.45 + 0.13 * cov + glint * 0.35);
        put(c, r, shade(DENSE, v, c, r, 2, 0.6), 0.35 + 0.6 * v, 0, true);
      }
    }
    // The arc: the ring's cells behind the head light up, fading along the arc; the cell at the head is @.
    let lead = null;
    for (const p of RING) {
      const behind = (((head - p.t) % TAU) + TAU) % TAU;
      if (behind > ARC) continue;
      put(p.c, p.r, p.ch, 0.35 + 0.65 * (1 - behind / ARC), 1);
      if (!lead || behind < lead.behind) lead = { p, behind };
    }
    if (lead) put(lead.p.c, lead.p.r, 64, 1, 1);
  }
  g.start(compose);
  g.canvas.addEventListener('pointerenter', () => (hover = true), { signal: g.signal });
  g.canvas.addEventListener('pointerleave', () => (hover = false), { signal: g.signal });
  return { el: g.canvas, destroy: g.destroy };
}

/**
 * The spinner beside what the agent does now: one braille character stepping through ten frames, like a terminal
 * agent's. Pure CSS (no timer), one fixed-width cell so the words beside it never move; still under reduced motion.
 */
export const asciiSpin = () => h('span', { class: 'ascii-spin', 'aria-hidden': 'true' });

// Art for empty panels. Characters inside {} are live: they glow in the signal colour, one after another.
const ART = {
  check: '--- a/\n+++ b/\n@@ {_} @@',
  branch: 'o---o---o\n     \\\n      o---{?}',
  list: '[x] -------\n[{>}] -----\n[ ] ------',
  users: '{o}   {o}   {o}\n \\  |  /\n   (@)',
  terminal: '.---------.\n| $ {_}     |\n\'---------\'',
};

/** Small art for an empty panel, by its kind: it inks in stroke by stroke, then its live parts glow. */
export function asciiArt(kind) {
  if (!ART[kind]) return null;
  const pre = h('pre', { class: 'ascii-art', 'aria-hidden': 'true' });
  let live = 0;
  ART[kind].split('\n').forEach((line, r) => {
    if (r) pre.append('\n');
    let c = 0;
    let on = false;
    for (const ch of line) {
      if (ch === '{' || ch === '}') {
        on = ch === '{';
        continue;
      }
      if (ch === ' ') pre.append(' ');
      else {
        const span = h('span', { class: on ? 'live' : null }, ch);
        span.style.setProperty('--d', `${(c + r * 3) * 22}ms`);
        if (on) span.style.setProperty('--l', live++);
        pre.append(span);
      }
      c++;
    }
  });
  return pre;
}
