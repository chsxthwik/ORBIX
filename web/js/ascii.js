// ASCII effects: the COM-X mark in About, and the loader beside what the agent does now. All of it is decoration: hidden
// from screen readers, never behind text, it sleeps while off screen, and under reduced motion (Windows' setting or Settings → Appearance → Screen reader mode) it shows one still frame.
import { h } from './dom.js';

const motionOff = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = { get matches() {
  const root = document.documentElement;
  return motionOff.matches || root.classList.contains('sr') || root.classList.contains('no-motion');
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
 * (cell = character code, alpha = strength, sig = 0 plain, 1 the brand colour, 2 quiet). The picture fades in from its centre.
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
  const cell = new Uint16Array(N); // UTF-16 code units: the orbit uses · ˙ • ●
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
          colors = [get('--fg', '#888'), get('--brand', get('--live', '#4c4')), get('--fg-3', '#666')]; // plain, signal, quiet
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
      theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-mode'] });
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
 * The spinner beside what the agent does now ("Thinking", "Reading src/app.js"): a 7×7 LED matrix in the live colour.
 * Every LED glows faintly; a comet orbits the ring with a fading tail while the core pulses. Drawn on a canvas at
 * about 16 frames a second, only while it is on the page; reduced motion shows one still frame.
 */
const LED = 7, PITCH = 3, DOT = 2;
export function asciiSpin() {
  const size = LED * PITCH;
  const cv = h('canvas', { class: 'ascii-spin', 'aria-hidden': 'true' });
  cv.style.width = cv.style.height = size + 'px';
  const ctx = cv.getContext('2d');
  const mid = (LED - 1) / 2;
  const cells = [];
  for (let r = 0; r < LED; r++) for (let c = 0; c < LED; c++) cells.push({ x: c * PITCH, y: r * PITCH, d: Math.hypot(c - mid, r - mid), a: Math.atan2(r - mid, c - mid) });
  let last = 0, dpr = 0, color = '';
  const draw = (t) => {
    const ratio = Math.min(devicePixelRatio || 1, 3);
    if (ratio !== dpr) (dpr = ratio), (cv.width = cv.height = Math.round(size * dpr));
    if (!color || t % 1000 < 70) color = getComputedStyle(cv).getPropertyValue('--plasma').trim() || '#3DF28C';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = color;
    const head = (t / 900) * TAU; // one orbit every 0.9 s
    const pulse = 0.5 + 0.5 * Math.sin(t / 260);
    for (const p of cells) {
      let v = 0.1; // the LED is off but visible
      if (p.d >= 1.6 && p.d <= 3.2) {
        const behind = (((head - p.a) % TAU) + TAU) % TAU; // how far the comet has passed this LED
        v = Math.max(v, Math.exp(-behind * 1.1) * (p.d < 2.5 ? 1 : 0.75));
      } else if (p.d < 1.6) v = Math.max(v, (p.d < 0.5 ? 0.55 : 0.28) + 0.4 * pulse * (p.d < 0.5 ? 1 : 0.5));
      ctx.globalAlpha = Math.min(1, v);
      ctx.shadowColor = color;
      ctx.shadowBlur = v > 0.5 ? 3 : 0;
      ctx.fillRect(p.x, p.y, DOT, DOT);
    }
    ctx.globalAlpha = 1;
  };
  const loop = (t) => {
    if (!cv.isConnected) return; // removed with its line: the loop ends
    if (t - last >= 60) (last = t), draw(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame((t) => (reduced.matches ? draw(450) : loop(t)));
  return cv;
}
