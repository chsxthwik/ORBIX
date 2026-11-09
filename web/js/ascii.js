// ASCII effects: the orbit on Home and in a new chat, the headline that decodes into place, the task box's typed examples,
// and small art for empty panels. All of it is decoration: hidden from screen readers, never behind text, it sleeps while
// off screen, and under prefers-reduced-motion it shows one still frame.
import { h } from './dom.js';

const RAMP = ' .:-=+*#%@';
const FG_ALPHA = [0.1, 0.16, 0.24, 0.34, 0.46, 0.6, 0.76, 0.92];
const SIGNAL_ALPHA = [0.4, 0.85, 1];
const TRAIL = '@Oo*+:..';
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * A planet and a tilted orbit drawn in characters on one canvas (the ORBIX mark as a little live system).
 * The light follows the pointer. mode: idle, busy (faster), wait (amber: it waits on you).
 */
export function asciiOrbit({ cols = 64, rows = 16, font = 9, lineH = 10 } = {}) {
  const cw = font * 0.6;
  const W = cols * cw;
  const H = rows * lineH;
  const canvas = h('canvas', { class: 'ascii-orbit', width: Math.round(W), height: Math.round(H), 'aria-hidden': 'true' });
  // Width may shrink (max-width: 100%); height follows the aspect ratio so the art is never squashed.
  canvas.style.width = `${W}px`;
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${W} / ${H}`;
  const ctx = canvas.getContext('2d', { alpha: true });
  const cell = new Uint8Array(cols * rows); // the character code at each cell
  const tone = new Uint8Array(cols * rows); // 0-7 text strength, 8-10 signal strength
  const R = H * 0.34;
  const a = Math.min(W * 0.47, R * 2.1);
  const b = a * 0.3;
  const TILT = (-24 * Math.PI) / 180;
  const cosT = Math.cos(TILT);
  const sinT = Math.sin(TILT);

  // A few fixed stars, the same on every launch.
  const stars = Array.from({ length: Math.round((cols * rows) / 70) }, (_, i) => {
    const n = Math.sin(i * 127.1) * 43758.5453;
    const m = Math.sin(i * 311.7) * 43758.5453;
    return { c: Math.floor((n - Math.floor(n)) * cols), r: Math.floor((m - Math.floor(m)) * rows), p: i * 1.7, ch: i % 4 ? 46 : 43 };
  });

  let mode = 'idle';
  let colors = null;
  let colorsAt = -1e9;
  let dpr = 0;
  const born = performance.now();
  let node = 0.6;
  let spin = 0;
  let last = 0;
  let drawnAt = 0;
  let seen = false;
  let light = [-0.42, -0.5];
  let aim = [-0.42, -0.5];
  const stop = new AbortController();

  const put = (c, r, ch, t) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const i = r * cols + c;
    cell[i] = ch;
    tone[i] = t;
  };
  const inSphere = (x, y) => x * x + y * y < R * R;
  const orbitAt = (t) => {
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    return [ex * cosT - ey * sinT, ex * sinT + ey * cosT];
  };

  function compose(time) {
    cell.fill(0);
    for (const s of stars) {
      const v = 0.5 + 0.5 * Math.sin(time * 0.0012 + s.p);
      if (v > 0.25) put(s.c, s.r, s.ch, v > 0.75 ? 2 : 1);
    }
    // Far side of the orbit first, so the planet covers it.
    for (let k = 0; k < 300; k++) {
      const t = (k / 300) * Math.PI * 2;
      if (Math.sin(t) >= 0) continue;
      const [x, y] = orbitAt(t);
      if (!inSphere(x, y)) put(Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH), 46, 8);
    }
    const lz = Math.sqrt(Math.max(0.05, 1 - light[0] * light[0] - light[1] * light[1]));
    for (let r = 0; r < rows; r++) {
      const dy = (r + 0.5) * lineH - H / 2;
      if (Math.abs(dy) > R) continue;
      for (let c = 0; c < cols; c++) {
        const dx = (c + 0.5) * cw - W / 2;
        if (!inSphere(dx, dy)) continue;
        const nx = dx / R;
        const ny = dy / R;
        const nz = Math.sqrt(1 - nx * nx - ny * ny);
        const lit = Math.max(0, nx * light[0] + ny * light[1] + nz * lz);
        const lon = Math.atan2(nx, nz) + spin;
        const lat = Math.asin(ny);
        const land = Math.sin(lon * 3 + Math.sin(lat * 5)) * Math.cos(lat * 2.5) + 0.5 * Math.sin(lon * 7 + lat * 3);
        const v = 0.13 + lit * (land > 0.12 ? 0.86 : 0.56);
        const ch = RAMP.charCodeAt(Math.min(RAMP.length - 1, Math.max(1, Math.round(v * (RAMP.length - 1)))));
        put(c, r, ch, Math.min(7, Math.floor(v * 8)));
      }
    }
    // Near side: first a clean gap through the planet, then a ring of small round characters.
    for (let k = 0; k < 300; k++) {
      const t = (k / 300) * Math.PI * 2;
      if (Math.sin(t) < 0) continue;
      const [x, y] = orbitAt(t);
      if (!inSphere(x, y)) continue;
      const c = Math.floor((x + W / 2) / cw);
      const r = Math.floor((y + H / 2) / lineH);
      put(c, r - 1, 0, 0);
      put(c, r + 1, 0, 0);
    }
    for (let k = 0; k < 300; k++) {
      const t = (k / 300) * Math.PI * 2;
      if (Math.sin(t) < 0) continue;
      const [x, y] = orbitAt(t);
      put(Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH), 111, 9);
    }
    // The node and its trail. Behind the planet, they are hidden.
    for (let k = TRAIL.length - 1; k >= 0; k--) {
      const t = node - k * 0.075;
      if (Math.sin(t) < 0 && inSphere(...orbitAt(t))) continue;
      const [x, y] = orbitAt(t);
      put(Math.floor((x + W / 2) / cw), Math.floor((y + H / 2) / lineH), TRAIL.charCodeAt(k), k < 3 ? 10 : k < 6 ? 9 : 8);
    }
  }

  function paint() {
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
    let fill = '';
    let alpha = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!cell[i]) continue;
        const t = tone[i];
        const nf = t >= 8 ? signal : colors.fg;
        const na = t >= 8 ? SIGNAL_ALPHA[t - 8] : FG_ALPHA[t];
        if (nf !== fill) ctx.fillStyle = fill = nf;
        if (na !== alpha) ctx.globalAlpha = alpha = na;
        ctx.fillText(String.fromCharCode(cell[i]), c * cw, (r + 0.5) * lineH);
      }
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
    paint();
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
let decodeId = 0;

/** Set the text, with its letters settling out of ASCII noise from left to right. The layout never moves. */
export function decodeText(el, text) {
  const id = ++decodeId;
  el.dataset.decode = id;
  el.textContent = text;
  el.removeAttribute('aria-label');
  if (reduced.matches || !text || !el.checkVisibility()) return;
  el.setAttribute('aria-label', text);
  const letters = [];
  el.replaceChildren(...text.split(' ').flatMap((word, w) => {
    const part = h('span', { class: 'dec-w', 'aria-hidden': 'true' }, [...word].map((c) => {
      const s = h('span', { class: 'dec-c' }, c);
      letters.push({ s, c });
      return s;
    }));
    return w ? [' ', part] : [part];
  }));
  // Fix each letter's width first, so a wider noise character cannot shift the line.
  for (const l of letters) l.w = l.s.getBoundingClientRect().width;
  letters.forEach((l, i) => {
    l.s.style.width = `${l.w}px`;
    l.at = 120 + (i / letters.length) * 420 + Math.random() * 130;
  });
  const t0 = performance.now();
  let lastSwap = 0;
  const step = (now) => {
    if (el.dataset.decode !== String(id)) return;
    const age = now - t0;
    const swap = now - lastSwap > 45;
    if (swap) lastSwap = now;
    let left = 0;
    for (const l of letters) {
      if (age >= l.at) {
        if (!l.done) {
          l.done = true;
          l.s.textContent = l.c;
          l.s.classList.remove('dec-n');
        }
      } else {
        left++;
        if (swap) {
          l.s.textContent = NOISE[Math.floor(Math.random() * NOISE.length)];
          l.s.classList.add('dec-n');
        }
      }
    }
    if (left) requestAnimationFrame(step);
    else {
      el.textContent = text;
      el.removeAttribute('aria-label');
    }
  };
  requestAnimationFrame(step);
}

/** While a text box is empty, type example tasks into its placeholder. */
export function typePlaceholder(ta, lines, prefix = '') {
  if (reduced.matches) return;
  let line = 0;
  let n = 0;
  let back = false;
  let seen = false;
  const born = performance.now();
  const next = () => {
    if (ta.isConnected) seen = true;
    else if (seen || performance.now() - born > 10000) return; // removed for good, or never inserted
    if (ta.value || !ta.checkVisibility() || document.hidden) return setTimeout(next, 800);
    const text = lines[line];
    if (back) {
      n = Math.max(0, n - 2);
      if (!n) {
        back = false;
        line = (line + 1) % lines.length;
      }
    } else if (n < text.length) n++;
    else {
      back = true;
      return setTimeout(next, 2600);
    }
    ta.placeholder = prefix + text.slice(0, n);
    setTimeout(next, back ? 14 : 34 + Math.random() * 34);
  };
  setTimeout(next, 1400);
}

const ART = {
  check: ' /\\_/\\\n( ^.^ )\n > ~ < ',
  branch: 'o---o---o\n     \\\n      o--?',
  list: '[x] ------\n[ ] ----\n[ ] -------',
  users: '[o_o]  [o_o]\n /|\\    /|\\ ',
};

/** Small art for an empty panel, by its kind. */
export const asciiArt = (kind) => (ART[kind] ? h('pre', { class: 'ascii-art', 'aria-hidden': 'true' }, ART[kind]) : null);
