// ASCII effects: the orbit on Home and in a new chat, the headline that decodes into place, the task box's typed examples,
// and small art for empty panels. All of it is decoration: hidden from screen readers, never behind text, it sleeps while
// off screen, and under prefers-reduced-motion it shows one still frame.
import { h } from './dom.js';

const RAMP = ' .:-=+*#%@';
const TRAIL = '@Oo*+:..';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
// 4x4 ordered dither, so shading steps between two characters instead of banding.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const hash = (i) => {
  const n = Math.sin(i * 12.9898) * 43758.5453;
  return n - Math.floor(n);
};

/**
 * A planet and a tilted orbit drawn in characters on one canvas (the ORBIX mark as a little live system).
 * The planet turns under a light that follows the pointer, its edge is anti-aliased, the ring is drawn with
 * characters that follow its slope, and the whole picture resolves out of noise when it first appears.
 * mode: idle, busy (faster), wait (amber: it waits on you).
 */
export function asciiOrbit({ cols = 64, rows = 15, font = 10, lineH = 12 } = {}) {
  const cw = font * 0.6;
  const W = cols * cw;
  const H = rows * lineH;
  const canvas = h('canvas', { class: 'ascii-orbit', width: Math.round(W), height: Math.round(H), 'aria-hidden': 'true' });
  // Width may shrink (max-width: 100%); height follows the aspect ratio so the art is never squashed.
  canvas.style.width = `${W}px`;
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${W} / ${H}`;
  const ctx = canvas.getContext('2d', { alpha: true });
  const N = cols * rows;
  const cell = new Uint8Array(N); // the character code at each cell
  const alpha = new Float32Array(N); // its strength, 0-1
  const sig = new Uint8Array(N); // 1 = drawn in the signal colour (orbit, node)
  const R = H * 0.34;
  const a = Math.min(W * 0.47, R * 2.1);
  const b = a * 0.3;
  const TILT = (-24 * Math.PI) / 180;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);
  const STEPS = 420;

  // A few fixed stars, the same on every launch, kept clear of the planet.
  const stars = [];
  for (let i = 0; stars.length < Math.round(N / 60) && i < 400; i++) {
    const c = Math.floor(hash(i * 3 + 1) * cols);
    const r = Math.floor(hash(i * 3 + 2) * rows);
    const dx = (c + 0.5) * cw - W / 2;
    const dy = (r + 0.5) * lineH - H / 2;
    if (dx * dx + dy * dy > (R + 10) * (R + 10)) stars.push({ c, r, p: hash(i * 3 + 3) * 6.283, s: 0.5 + hash(i * 7) * 1.4, ch: i % 5 ? 46 : 43 });
  }

  let mode = 'idle';
  let colors = null;
  let colorsAt = -1e9;
  let dpr = 0;
  const born = performance.now();
  let shownAt = 0;
  let node = 0.6;
  let spin = 0;
  let last = 0;
  let drawnAt = 0;
  let seen = false;
  let light = [-0.42, -0.5];
  let aim = [-0.42, -0.5];
  const stop = new AbortController();

  const put = (c, r, ch, al, signal = 0) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const i = r * cols + c;
    cell[i] = ch;
    alpha[i] = al;
    sig[i] = signal;
  };
  const inSphere = (x, y) => x * x + y * y < R * R;
  const orbitAt = (t) => {
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    return [ex * cosT - ey * sinT, ex * sinT + ey * cosT];
  };
  /** The character that follows the ring's slope where it crosses a cell, so the ring reads as one line. */
  const ringChar = (t, y) => {
    const ex = -a * Math.sin(t);
    const ey = b * Math.cos(t);
    const dx = (ex * cosT - ey * sinT) / cw;
    const dy = (ex * sinT + ey * cosT) / lineH;
    // The two ends, where the ring turns back on itself.
    if (Math.abs(Math.cos(t)) > 0.992) return Math.cos(t) > 0 ? 41 : 40; // ) and (
    const slope = Math.abs(dx) < 1e-6 ? 99 : dy / dx;
    if (slope > 0.5) return 92; // \
    if (slope < -0.5) return 47; // /
    const fy = (y + H / 2) / lineH;
    return fy - Math.floor(fy) > 0.62 ? 95 : 45; // _ low in the cell, - otherwise: no stair steps
  };
  const ring = (near) => {
    for (let k = 0; k < STEPS; k++) {
      const t = (k / STEPS) * Math.PI * 2;
      if (Math.sin(t) >= 0 !== near) continue;
      const [x, y] = orbitAt(t);
      if (!near && inSphere(x, y)) continue; // the far side passes behind the planet
      put(Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH), ringChar(t, y), near ? 0.92 : 0.42, 1);
    }
  };

  function compose(time) {
    cell.fill(0);
    for (const s of stars) {
      const v = 0.5 + 0.5 * Math.sin(time * 0.001 * s.s + s.p);
      put(s.c, s.r, s.ch, 0.07 + 0.3 * v * v);
    }
    ring(false);
    // The planet: a lit, turning sphere. Four samples per cell soften its edge.
    const lz = Math.sqrt(Math.max(0.05, 1 - light[0] * light[0] - light[1] * light[1]));
    const hl = Math.hypot(light[0], light[1], lz + 1) || 1; // half vector between the light and the viewer
    const hx = light[0] / hl;
    const hy = light[1] / hl;
    const hz = (lz + 1) / hl;
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * lineH - H / 2;
      if (Math.abs(cy) > R + lineH) continue;
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * cw - W / 2;
        if (Math.abs(cx) > R + cw) continue;
        let cov = 0;
        for (let s = 0; s < 4; s++) if (inSphere(cx + (s & 1 ? 0.25 : -0.25) * cw, cy + (s & 2 ? 0.25 : -0.25) * lineH)) cov++;
        if (!cov) continue;
        const len = Math.hypot(cx, cy);
        const k = len > R * 0.985 ? (R * 0.985) / len : 1; // edge cells shade from a point just inside the limb
        const nx = (cx * k) / R;
        const ny = (cy * k) / R;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = Math.max(0, nx * light[0] + ny * light[1] + nz * lz);
        const lon = Math.atan2(nx, nz) + spin;
        const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
        const land = Math.sin(lon * 3 + Math.sin(lat * 5)) * Math.cos(lat * 2.5) + 0.5 * Math.sin(lon * 7 + lat * 3);
        const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 28) * 0.35;
        const v = Math.min(1, (0.1 + lit * (land > 0.12 ? 0.86 : 0.52) + spec) * (0.4 + 0.15 * cov));
        const idx = Math.round(v * (RAMP.length - 1) + BAYER[(c & 3) + (r & 3) * 4] * 0.7);
        put(c, r, RAMP.charCodeAt(Math.min(RAMP.length - 1, Math.max(1, idx))), 0.12 + 0.82 * v);
      }
    }
    // Near side: the ring passes in front of the planet.
    ring(true);
    // The node and its fading trail. Behind the planet they are hidden.
    for (let k = TRAIL.length - 1; k >= 0; k--) {
      const t = node - k * 0.07;
      const [x, y] = orbitAt(t);
      if (Math.sin(t) < 0 && inSphere(x, y)) continue;
      put(Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH), TRAIL.charCodeAt(k), 1 - (k / TRAIL.length) * 0.72, 1);
    }
  }

  function paint(time) {
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (ratio !== dpr) {
      dpr = ratio;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    // Re-read the palette about twice a second, so a theme or system light/dark change is picked up however it happens.
    const now = performance.now();
    if (!colors || now - colorsAt > 500) {
      colorsAt = now;
      const css = getComputedStyle(document.documentElement);
      const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      colors = { fg: get('--fg', '#888'), live: get('--live', '#4c4'), warn: get('--warn', '#fb3') };
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${font}px "JetBrains Mono Variable", Consolas, monospace`;
    ctx.textBaseline = 'middle';
    const signal = mode === 'wait' ? colors.warn : colors.live;
    // The first 0.9 s: each cell shows noise until its turn, so the picture resolves instead of popping in.
    const intro = reduced.matches ? 1 : Math.min(1, (time - shownAt) / 900);
    const flick = Math.floor(time / 60);
    let fill = '';
    for (let i = 0; i < N; i++) {
      if (!cell[i]) continue;
      const nf = sig[i] ? signal : colors.fg;
      if (nf !== fill) ctx.fillStyle = fill = nf;
      const settled = intro >= 1 || hash(i) < intro;
      ctx.globalAlpha = settled ? alpha[i] : alpha[i] * 0.45;
      ctx.fillText(settled ? String.fromCharCode(cell[i]) : NOISE[(i * 7 + flick) % NOISE.length], (i % cols) * cw, (Math.floor(i / cols) + 0.5) * lineH);
    }
    ctx.globalAlpha = 1;
  }

  function tick(time) {
    if (stop.signal.aborted) return;
    if (canvas.isConnected) seen = true;
    else if (seen || time - born > 10000) return stop.abort(); // removed for good, or never inserted
    requestAnimationFrame(tick);
    const still = reduced.matches;
    const hidden = !canvas.isConnected || document.hidden || !canvas.checkVisibility();
    if (hidden) {
      last = time; // no time debt while asleep: it resumes smoothly instead of jumping
      return;
    }
    // 40 ms (not 50) so 60 Hz screens draw every third frame evenly instead of alternating 3 and 4.
    if (time - drawnAt < (still ? 1000 : 40)) return;
    drawnAt = time;
    if (!shownAt) shownAt = time;
    const dt = Math.min(0.1, (time - last) / 1000 || 0);
    last = time;
    if (!still) {
      const speed = mode === 'busy' ? 2.4 : mode === 'wait' ? 0.25 : 0.65;
      node = (node + dt * speed) % (Math.PI * 2);
      spin = (spin + dt * (mode === 'busy' ? 0.7 : 0.22)) % (Math.PI * 2);
      const k = 1 - Math.pow(0.08, dt * 3); // easing that does not depend on the frame rate
      light = [light[0] + (aim[0] - light[0]) * k, light[1] + (aim[1] - light[1]) * k];
    }
    compose(still ? 0 : time);
    paint(time);
  }
  requestAnimationFrame(tick);

  {
    let queued = false;
    let ev = null;
    const clamp = (v) => Math.max(-0.55, Math.min(0.55, v));
    addEventListener('pointermove', (e) => {
      ev = e;
      if (queued || reduced.matches) return;
      queued = true; // measure at most once per frame: no layout read on every pointer event
      requestAnimationFrame(() => {
        queued = false;
        if (!ev || !canvas.isConnected) return;
        const box = canvas.getBoundingClientRect();
        if (!box.width) return;
        aim = [clamp((ev.clientX - (box.left + box.width / 2)) / 600), clamp((ev.clientY - (box.top + box.height / 2)) / 400)];
      });
    }, { passive: true, signal: stop.signal });
    // The light settles back when the pointer leaves the window.
    document.documentElement.addEventListener('pointerleave', () => (aim = [-0.42, -0.5]), { signal: stop.signal });
  }
  return { el: canvas, setMode: (m) => (mode = m) };
}

const NOISE = '/\\|-+*=<>#%';

const ART = {
  check: ' /\\_/\\\n( ^.^ )\n > ~ < ',
  branch: 'o---o---o\n     \\\n      o--?',
  list: '[x] ------\n[ ] ----\n[ ] -------',
  users: '[o_o]  [o_o]\n /|\\    /|\\ ',
};

/** Small art for an empty panel, by its kind. */
export const asciiArt = (kind) => (ART[kind] ? h('pre', { class: 'ascii-art', 'aria-hidden': 'true' }, ART[kind]) : null);
