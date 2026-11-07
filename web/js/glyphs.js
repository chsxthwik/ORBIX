// Workspace glyph field: the background of the .main sheet.
// One canvas behind the content sets the ORBIX mark in JetBrains Mono on a character grid: the planet outline and the
// orbit (an ellipse tilted -24deg at the logo's own proportions: rx 10.5, ry 4, planet r 6.5) drawn in line characters
// over sparse patches of dots and code glyphs. The far side of the orbit is hidden behind the planet.
// It carries the app's two signals and nothing else:
//   idle   static and neutral; the node rests where the logo's dot is.
//   busy   teal: the node travels the orbit and the ring it has just passed settles back from teal to neutral.
//   wait   orange: the node parks; in a session a dotted lead runs down the margin and points at what waits on you.
// Home: a full-screen backdrop (planet with rings and orbit) behind the frosted cards; it scrolls with Home and steps back
// behind the heading and the lists.
// Session: the same mark, sized so its ends sit in the margins; nothing is ever drawn inside the reading column.
// Cost: it draws once and stops. While the agent works it ticks (~12 fps, changed cells only), sleeps while the node
// is behind the reading column, stops while the window is hidden and never animates under prefers-reduced-motion.

// Cell size in CSS px, per view: Home uses a finer grid so the mark in its header has enough cells to read as a
// sphere; a session keeps the coarser, quieter grid in its margins.
const GRID = {
  home: { cw: 10, ch: 14, font: "450 9px 'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace" },
  session: { cw: 14, ch: 20, font: "450 11px 'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace" },
};
let CW = 14, CH = 20, FONT = GRID.session.font;
// Planet light on Home: from the top left, like the logo.
const LIGHT = (() => {
  const v = [-0.52, -0.62, 0.58], m = Math.hypot(...v);
  return v.map((x) => x / m);
})();
const SPIN = 26000; // ms per turn of the planet's surface
// Ring system, as [inner, outer, strength] in orbit radii (the orbit line, the node's path, is at 1.0 in the wide
// gap): a faint inner ring, the bright main ring, the wide gap, the outer ring with a thin gap, and a hairline ring.
const RING_BANDS = [
  [0.74, 0.84, 0.36],
  [0.86, 0.965, 1],
  [1.035, 1.085, 0.72],
  [1.1, 1.15, 0.6],
  [1.19, 1.215, 0.42],
];
const RING_SPIN = 60000; // ms per turn of the ring texture (it circulates; the planet turns slower)
const RING_CH = ['.', '·', ':', '+', '*'];
const DOT = '·';
const CODE = ['+', '-', '=', ':', ';', '/', '*', '0', '1', '{', '}', '<', '>', '_', '.', '#'];
const TICK = 83, FAST = 33, PERIOD = 10000, TRAIL = 0.2, GLIDE = 700, LEAD = 12;
const TAU = Math.PI * 2;
const TILT = (-24 * Math.PI) / 180, RY = 4 / 10.5, RP = 6.5 / 10.5;
const BRAND = [8.9 / 10.5, -5 / 10.5]; // the logo's node, from its centre, in orbit radii
// The one place to tune weights. quiet: what is left of the type behind Home's heading (session: the reading column).
const TUNE = {
  home: { field: 0.075, ring: 0.42, planet: 0.34, sig: 1, quiet: 0.4 },
  session: { field: 0.08, ring: 0.32, planet: 0.2, sig: 0.8, quiet: 0 },
};

let F = null;
const want = { view: 'home', mode: 'idle', tab: '' };

/** view: 'home' | 'session'; mode: 'idle' | 'busy' | 'wait'; tab: the active tab id. Cheap and idempotent. */
export function setGlyphs(next) {
  Object.assign(want, next);
  F?.set();
}

/** Home was redrawn: re-measure its layout (the field rebuilds only if something moved). */
export function refreshGlyphs() {
  F?.refresh();
}

/** Mount the field at the back of the workspace sheet. Call once Home has been drawn. */
export function mountGlyphs(main) {
  if (!F && main) F = createField(main);
}

const hash = (x, y) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const wrap01 = (x) => x - Math.floor(x);
const tdist = (a, b) => Math.abs(((a - b + 1.5) % 1) - 0.5);
const clamp = (lo, v, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, x) => {
  const t = clamp(0, (x - a) / (b - a), 1);
  return t * t * (3 - 2 * t);
};
const dpr = () => Math.min(2, window.devicePixelRatio || 1);
/** A line character for a direction (radians, screen space, y down). */
function tangentGlyph(a) {
  a = ((a % Math.PI) + Math.PI) % Math.PI;
  const e = Math.PI / 8;
  return a < e || a >= 7 * e ? '-' : a < 3 * e ? '\\' : a < 5 * e ? '|' : '/';
}
/** Layout box of el relative to `root`, from offsets: immune to transforms (entrances) and to root's own scroll. */
function boxIn(el, root) {
  let x = 0, y = 0, e = el;
  while (e && e !== root) {
    x += e.offsetLeft;
    y += e.offsetTop;
    e = e.offsetParent;
  }
  return e === root ? { l: x, t: y, r: x + el.offsetWidth, b: y + el.offsetHeight } : null;
}

function createField(main) {
  const wrap = document.createElement('div');
  wrap.className = 'glyphs';
  wrap.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  wrap.append(canvas);
  main.prepend(wrap);
  const ctx = canvas.getContext('2d');
  const root = document.documentElement;
  const welcome = main.querySelector('#welcome');
  const topbar = main.querySelector('#topbar');
  const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');

  let view = want.view === 'session' ? 'session' : 'home', mode = want.mode || 'idle', tab = want.tab || '';
  let W = 0, H = 0, cols = 0, rows = 0, offX = 0;
  let base = [], kind = new Uint8Array(0), alpha = new Float32Array(0), vis = new Float32Array(0), heat = new Float32Array(0), lead = new Uint8Array(0);
  let ring = []; // orbit cells in travel order: { i, t, x, y }
  let ringSeen = false; // any orbit cell outside the reading column
  let G = null, geo = null, key = '';
  let C = { field: '#84847E', ring: '#A8A8A1', live: '#33D1BE', node: '#FF7A2E', you: '#FF9A5C', mul: 1 };
  let tune = TUNE.home;
  let nodeT = 0, nodeCell = -1, glide = null;
  let leadOrder = [], leadShown = 0, leadEnd = '';
  let timer = 0, last = 0, maxDt = 250, pending = false, dirty = false, swapTimer = 0, swapping = false, dockEl = null, dockRaf = 0;
  let heated = false, seen = false;
  // Lens: how strongly the pointer (or the idle shimmer) lights each cell, 0..1; decays every frame.
  let glow = new Float32Array(0);
  let planet = []; // Home: interior cells of the planet { i, nx, ny, nz, q }
  let pcol = new Uint8Array(0); // planet and ring cell ink: 0 ring, 1 field, 2 warm (night lights)
  let rings = []; // Home: ring-system cells { i, e, band, th, side, front, q }
  // Entrance: 0..1 while the field ripples out from the planet after a rebuild on Home; 1 = fully shown.
  let reveal = 1, revealRaf = 0, revealT0 = 0, revealMax = 1, revealNext = true;
  const cruising = () => view === 'home' && mode === 'idle' && !reduceMq.matches;
  function revealAt(i) {
    if (!geo) return 1;
    const x = offX + (i % cols) * CW + CW / 2 - geo.cx, y = ((i / cols) | 0) * CH + CH / 2 - geo.cy;
    const d = Math.hypot(x, y) / revealMax; // 0 at the planet, 1 at the farthest cell
    return smooth(d - 0.12, d + 0.05, reveal * 1.17);
  }
  function startReveal() {
    if (reduceMq.matches || view !== 'home') return void (reveal = 1);
    revealMax = Math.max(W, H) || 1;
    reveal = 0;
    revealT0 = performance.now();
    cancelAnimationFrame(revealRaf);
    const step = (now) => {
      reveal = Math.min(1, (now - revealT0) / 1100);
      reveal = 1 - (1 - reveal) ** 3;
      paintAll();
      revealRaf = reveal < 1 ? requestAnimationFrame(step) : 0;
    };
    revealRaf = requestAnimationFrame(step);
  }
  let spinTimer = 0, spinLast = 0;
  const lit = new Set();
  let lensRaf = 0, lensLast = 0, frame = 0, shimmerTimer = 0;

  function readTokens() {
    const cs = getComputedStyle(root);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    C = { field: v('--fg-3', '#84847E'), ring: v('--fg-2', '#A8A8A1'), live: v('--live', '#33D1BE'), node: v('--accent-solid', '#FF7A2E'), you: v('--accent', '#FF9A5C'), mul: root.dataset.theme === 'light' ? 1.15 : 1 };
  }

  /** Where the mark sits and where the type must step back, in the field's coordinates (below the top bar). */
  function measure() {
    const gr = GRID[view] || GRID.session;
    CW = gr.cw;
    CH = gr.ch;
    FONT = gr.font;
    const top = topbar?.offsetHeight || 0;
    const w = main.clientWidth, h = main.clientHeight - top;
    if (w < 1 || h < 1) return null;
    const g = { view, top, w, h, hc: h, cx: w / 2, cy: 0, rx: 0, col: 0, quiet: [] };
    if (view === 'home' && welcome) {
      // Dashboard: the cards are opaque, so the type lives in the header band and the margins. The mark sits in the
      // header, right of centre, sized to the band; the heading, the chips and the emblem are quiet zones.
      const y0 = welcome.offsetTop - top;
      const head = welcome.querySelector('.d-head');
      const art = welcome.querySelector('.d-art');
      const hb = head && head.offsetWidth ? boxIn(head, welcome) : null;
      const ab = art && art.offsetWidth > 120 ? boxIn(art, welcome) : null;
      if (hb) {
        // Full-screen backdrop: the mark is centred on the visible sheet, its orbit spanning almost the whole width,
        // the planet as tall as the view allows. The cards are translucent (app.css) so it shows through them.
        g.cx = w / 2;
        g.cy = y0 + h * 0.5;
        // Sized so the outermost ring (1.215 orbit radii) still fits the sheet's width with a margin.
        g.rx = clamp(200, Math.min((w * 0.47) / (0.927 * 1.215), (h * 0.84) / (2 * RP)), 820);
        g.band = { t: 0, b: 1e9 };
        g.cards = [];
        for (const el of welcome.querySelectorAll('.d-card, .d-kpis')) {
          const q = boxIn(el, welcome);
          if (q && q.r > q.l) g.cards.push({ l: q.l, t: y0 + q.t, r: q.r, b: y0 + q.b });
        }
      } else if (hb && ab) {
        // The whole mark fits the art area: the planet's diameter in the band's height, the orbit in its width
        // (the orbit's horizontal reach is 0.927 rx each side).
        // A backdrop, not a picture in a box: the mark uses the art area plus the empty margin to its right (up to
        // the sheet's edge), and the planet is a little taller than the header, so it rises from behind the cards.
        const bh = hb.b - hb.t;
        const left = ab.l + 8, right = w - 28;
        const span = Math.max(0, right - left);
        g.cy = y0 + hb.t + bh * 0.52;
        // Never taller than the space above it allows: the planet's top keeps a row and a half of air below the top bar.
        g.rx = clamp(110, Math.min(span / 2 / 0.95, (bh * 1.22) / (2 * RP), (g.cy - CH * 1.5) / RP), 300);
        g.cx = left + span / 2;
        g.band = { t: y0 + hb.t - 36, b: y0 + hb.b + 12 };
      } else if (hb) {
        // Narrow window: no art area, the field alone fills the header band.
        g.rx = 0;
        g.cx = -9999;
        g.cy = y0 + hb.t;
        g.band = { t: y0 + hb.t - 36, b: y0 + hb.b + 12 };
      } else {
        g.rx = 220;
        g.cy = h * 0.2;
        g.band = { t: 0, b: h * 0.35 };
      }
      for (const el of welcome.querySelectorAll('.d-head-l > *, .d-head-r, .d-emblem, .home-keys')) {
        const q = boxIn(el, welcome);
        if (q && q.r > q.l) g.quiet.push({ l: q.l - 10, t: y0 + q.t - 6, r: q.r + 10, b: y0 + q.b + 6 });
      }
      // The whole scrollable page, so the margins carry type all the way down.
      g.hc = Math.ceil(h + Math.max(0, welcome.scrollHeight - welcome.clientHeight));
    } else {
      const col = parseFloat(getComputedStyle(root).getPropertyValue('--col')) || 820;
      let half = Math.min(col, w - 48) / 2;
      const tin = main.querySelector('#session .tin');
      const b = tin && tin.offsetWidth ? boxIn(tin, main) : null;
      if (b) {
        const cs = getComputedStyle(tin);
        g.cx = b.l + tin.offsetWidth / 2;
        half = (tin.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 2;
      }
      g.col = half;
      g.cy = h * 0.42;
      // The orbit's ends (its horizontal extent is 0.927 rx) land in the middle of the margins.
      const gut = Math.max(0, Math.min(g.cx - half, w - g.cx - half));
      g.rx = Math.max(240, (half + gut * 0.55) / 0.927);
    }
    return g;
  }

  const keyOf = (g) => [g.view, tab, g.w, g.h, g.hc, g.cx, g.cy, g.rx, g.col].map((n) => (typeof n === 'number' ? Math.round(n) : n)).join('|') + '|' + [...g.quiet, ...(g.cards || [])].map((q) => [q.l, q.t, q.r, q.b].map(Math.round).join(',')).join(';') + `|${dpr()}|${C.field}|${C.ring}|${C.live}|${C.node}|${C.you}|${C.mul}`;

  function cellOf(x, y) {
    const c = Math.floor((x - offX) / CW), r = Math.floor(y / CH);
    return c < 0 || r < 0 || c >= cols || r >= rows ? -1 : r * cols + c;
  }

  function build(g) {
    const d = dpr();
    W = g.w;
    H = g.hc;
    const pw = Math.round(W * d), ph = Math.round(H * d);
    if (canvas.width !== pw || canvas.height !== ph) (canvas.width = pw), (canvas.height = ph);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    cols = Math.ceil(W / CW);
    rows = Math.ceil(H / CH);
    offX = Math.round((W - cols * CW) / 2);
    const n = cols * rows;
    base = new Array(n).fill('');
    kind = new Uint8Array(n); // 0 field, 1 planet outline, 2 orbit
    alpha = new Float32Array(n);
    vis = new Float32Array(n); // 0 where text is read (nothing moves or lights there) .. 1
    heat = new Float32Array(n);
    lead = new Uint8Array(n);
    glow = new Float32Array(n);
    pcol = new Uint8Array(n);
    lit.clear();
    tune = TUNE[g.view];
    const { cx, cy, rx } = g, ry = rx * RY, rp = rx * RP, home = g.view === 'home';
    const quiet = new Float32Array(n);

    // 1. Visibility, and the field: value-noise patches of dots and code glyphs.
    for (let r = 0; r < rows; r++) {
      const yc = r * CH + CH / 2;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, xc = offX + c * CW + CW / 2;
        let q = 1, m = 1, fall = 1;
        if (home) {
          // Full strength in the header band, a lighter field down the margins; it steps back behind the text.
          const band = g.band;
          const out = yc < band.t ? band.t - yc : yc > band.b ? yc - band.b : 0;
          fall = 1 - 0.45 * smooth(0, 220, out);
          // Behind text the type steps back, feathered over ~28 px so the planet is never cut into rectangles.
          for (const b of g.quiet) {
            const inset = Math.min(xc - b.l, b.r - xc, yc - b.t, b.b - yc);
            if (inset > -28) {
              const f = smooth(-28, 6, inset);
              q = Math.min(q, 1 - (1 - tune.quiet) * f);
              if (inset > 0) m = 0;
            }
          }
          // Behind a card: drawn as is (the frosted card softens it), never lit or animated (you read there).
          if (g.cards) for (const b of g.cards) if (xc > b.l && xc < b.r && yc > b.t && yc < b.b) m = 0;
        } else {
          q = m = smooth(g.col - 4, g.col + 44, Math.abs(xc - cx)); // margins only
        }
        quiet[i] = q;
        vis[i] = m;
        if (q * fall < 0.01) continue;
        const dn = noise(c * 0.11, r * 0.16) * 0.65 + noise(c * 0.37 + 11, r * 0.5 + 7) * 0.35;
        const cut = home ? 0.58 : 0.5; // Home: sparser, so the field reads as texture, not text
        if (dn < cut) continue;
        const k = (dn - cut) / (1 - cut);
        base[i] = hash(c, r + 99) < 0.72 ? DOT : CODE[(hash(c + 7, r) * CODE.length) | 0];
        alpha[i] = tune.field * (0.5 + k * 1.1) * (Math.hypot(xc - cx, yc - cy) < rp ? 0.45 : 1) * q * fall * C.mul;
      }
    }

    // 2a. Home: the planet's interior as a shaded sphere (kind 3). Each cell keeps its surface normal; planetTick
    //     turns the shading into characters and slowly rotates a surface texture across it.
    planet = [];
    if (home && rp > CW * 3) {
      const inner = rp - CW * 0.7;
      for (let r = Math.floor((cy - inner) / CH); r <= Math.ceil((cy + inner) / CH); r++) {
        for (let c = Math.floor((cx - inner - offX) / CW); c <= Math.ceil((cx + inner - offX) / CW); c++) {
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const i = r * cols + c;
          const nx = (offX + c * CW + CW / 2 - cx) / rp, ny = (r * CH + CH / 2 - cy) / rp;
          const d2 = nx * nx + ny * ny;
          if (d2 >= (inner / rp) ** 2) continue;
          kind[i] = 3;
          base[i] = '';
          alpha[i] = 0;
          planet.push({ i, nx, ny, nz: Math.sqrt(1 - d2), q: quiet[i] });
        }
      }
      shadePlanet(performance.now());
      // Atmosphere: a thin haze just outside the rim, brighter on the lit side, fading outward.
      const hz = rp * 0.1 + CH;
      for (let r = Math.floor((cy - rp - hz) / CH); r <= Math.ceil((cy + rp + hz) / CH); r++) {
        for (let c = Math.floor((cx - rp - hz - offX) / CW); c <= Math.ceil((cx + rp + hz - offX) / CW); c++) {
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const i = r * cols + c;
          if (kind[i]) continue;
          const dx = offX + c * CW + CW / 2 - cx, dy = r * CH + CH / 2 - cy;
          const d = Math.hypot(dx, dy);
          if (d <= rp + 2 || d >= rp + hz) continue;
          const side = clamp(0, 0.35 + 0.65 * ((dx / d) * LIGHT[0] + (dy / d) * LIGHT[1]), 1); // facing the light
          const fall = 1 - (d - rp) / hz;
          if (hash(c, r + 5) > 0.35 + 0.5 * fall) continue; // denser near the rim
          base[i] = fall > 0.6 ? ':' : '.';
          alpha[i] = Math.max(alpha[i], tune.planet * 0.55 * fall * side * quiet[i] * C.mul);
        }
      }
    }

    // 2. Planet outline.
    const ps = Math.ceil((TAU * rp) / 3);
    for (let s = 0; s < ps; s++) {
      const a = (s / ps) * TAU;
      const i = cellOf(cx + rp * Math.cos(a), cy + rp * Math.sin(a));
      if (i < 0 || kind[i]) continue;
      kind[i] = 1;
      base[i] = tangentGlyph(a + Math.PI / 2);
      alpha[i] = tune.planet * quiet[i] * C.mul;
    }

    // 3. Orbit: the far half is hidden behind the planet, the near half passes in front of it.
    ring = [];
    ringSeen = false;
    const per = TAU * Math.sqrt((rx * rx + ry * ry) / 2), rs = Math.ceil(per / 3);
    const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
    for (let s = 0; s < rs; s++) {
      const th = (s / rs) * TAU, lx = rx * Math.cos(th), ly = ry * Math.sin(th);
      const x = cx + lx * cosT - ly * sinT, y = cy + lx * sinT + ly * cosT;
      const back = ly < 0;
      if (back && Math.hypot(x - cx, y - cy) < rp - CH * 0.25) continue;
      const i = cellOf(x, y);
      if (i < 0 || kind[i] === 2 || (kind[i] === 1 && back)) continue;
      const dlx = -rx * Math.sin(th), dly = ry * Math.cos(th);
      kind[i] = 2;
      base[i] = tangentGlyph(Math.atan2(dlx * sinT + dly * cosT, dlx * cosT - dly * sinT));
      alpha[i] = tune.ring * quiet[i] * C.mul;
      ring.push({ i, t: s / rs, x, y });
      if (vis[i] > 0.01) ringSeen = true;
    }
    geo = { cx, cy, rx, tol: 8 / rs };

    // 4. Home: the ring system around the planet (kind 5), in the orbit's plane. The orbit line itself (kind 2, the
    //    node's path) runs through the wide gap. The far side is hidden behind the planet; the near side crosses it.
    rings = [];
    if (home && rx > 160) {
      const ext = RING_BANDS[RING_BANDS.length - 1][1];
      const hx = rx * ext + CW, hy = rx * ext * Math.abs(sinT) + ry * ext * Math.abs(cosT) + CH;
      for (let r = Math.max(0, Math.floor((cy - hy) / CH)); r <= Math.min(rows - 1, Math.ceil((cy + hy) / CH)); r++) {
        for (let c = Math.max(0, Math.floor((cx - hx - offX) / CW)); c <= Math.min(cols - 1, Math.ceil((cx + hx - offX) / CW)); c++) {
          const i = r * cols + c;
          if (kind[i] === 1 || kind[i] === 2) continue;
          const dx = offX + c * CW + CW / 2 - cx, dy = r * CH + CH / 2 - cy;
          const lx = dx * cosT + dy * sinT, ly = -dx * sinT + dy * cosT; // into the ring's own frame
          const e = Math.hypot(lx / rx, ly / ry);
          const band = RING_BANDS.findIndex(([a, b]) => e >= a && e < b);
          if (band < 0) continue;
          const back = ly < 0;
          if (back && Math.hypot(dx, dy) < rp + CW * 0.3) continue; // behind the planet
          kind[i] = 5;
          base[i] = '';
          alpha[i] = 0;
          // Light from the top left: the half of the ring facing it is brighter.
          const d = Math.hypot(dx, dy) || 1;
          const side = clamp(0, 0.5 + 0.5 * ((dx / d) * LIGHT[0] + (dy / d) * LIGHT[1]) / Math.hypot(LIGHT[0], LIGHT[1]), 1);
          rings.push({ i, e, band, th: Math.atan2(ly / ry, lx / rx), side, front: !back, q: quiet[i] });
        }
      }
      shadeRings(performance.now());
    }
  }

  const nodeAlpha = () => (mode === 'idle' ? Math.min(1, tune.ring * 2 * C.mul) : tune.sig);

  function paintCell(i, clear = true) {
    const x = offX + (i % cols) * CW, y = ((i / cols) | 0) * CH;
    if (clear) ctx.clearRect(x, y, CW, CH);
    if (i === nodeCell) {
      const a = nodeAlpha() * vis[i];
      if (a > 0.01) {
        ctx.globalAlpha = Math.min(1, a);
        ctx.fillStyle = mode === 'wait' ? C.node : mode === 'busy' ? C.live : C.ring;
        ctx.beginPath();
        ctx.arc(x + CW / 2, y + CH / 2, view === 'home' ? 3 : 2.5, 0, TAU);
        ctx.fill();
        return;
      }
    }
    const k = kind[i];
    let ch = base[i], col = k === 3 || k === 5 ? (pcol[i] === 1 ? C.field : pcol[i] === 2 ? C.you : C.ring) : k ? C.ring : C.field, a = alpha[i];
    const gl = glow[i] * vis[i];
    if (gl > 0.02 && !lead[i]) {
      // Under the lens: the type brightens, empty cells reveal code, and field glyphs scramble while the light is
      // strong. The centre of the lens takes your colour; the edge stays neutral.
      if (!ch) ch = CODE[(hash(i, 7) * CODE.length) | 0];
      else if (!kind[i] && gl > 0.4) ch = CODE[((hash(i, frame >> 1) * CODE.length) | 0)];
      const top = (kind[i] ? 0.95 : 0.7) * C.mul;
      a += (top - a) * gl;
      if (gl > 0.55) col = kind[i] === 2 ? C.live : C.you;
      else if (gl > 0.2) col = C.ring;
    } else if (lead[i] && lead[i] <= leadShown) {
      ch = lead[i] === leadOrder.length ? leadEnd || DOT : DOT;
      col = C.you;
      a = tune.sig * (0.3 + (0.6 * lead[i]) / leadOrder.length) * vis[i];
    } else if (heat[i] > 0 && vis[i] > 0) {
      const live = mode === 'busy';
      const top = tune.sig * (live ? 0.7 : 0.5) * vis[i];
      if (top > a) (col = live ? C.live : C.ring), (a += (top - a) * heat[i]);
    }
    if (reveal < 1) a *= revealAt(i);
    if (!ch || a < 0.004) return;
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.fillText(ch, x + CW / 2, y + CH / 2 + 0.5);
  }

  function paintAll() {
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < base.length; i++) paintCell(i, false);
  }

  /** The orbit cell at parameter t, or -1 where the orbit is behind the planet. */
  function cellAt(t) {
    const n = ring.length;
    if (!n) return -1;
    let lo = 0, hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ring[m].t < t) lo = m + 1;
      else hi = m;
    }
    const a = ring[lo % n], b = ring[(lo - 1 + n) % n];
    const da = tdist(a.t, t), db = tdist(b.t, t);
    return Math.min(da, db) <= geo.tol ? (da < db ? a.i : b.i) : -1;
  }

  function nearest(x, y, minVis) {
    let best = null, bd = Infinity;
    for (const e of ring) {
      if (vis[e.i] < minVis) continue;
      const d = (e.x - x) ** 2 + (e.y - y) ** 2;
      if (d < bd) (bd = d), (best = e);
    }
    return best;
  }
  function brandT() {
    if (!geo) return 0;
    const x = geo.cx + BRAND[0] * geo.rx, y = geo.cy + BRAND[1] * geo.rx;
    return (nearest(x, y, 0.5) || nearest(x, y, 0))?.t ?? 0;
  }

  function setNode(t) {
    nodeT = wrap01(t);
    const c = cellAt(nodeT);
    if (c === nodeCell) return;
    const old = nodeCell;
    nodeCell = c;
    if (old >= 0) paintCell(old);
    if (c >= 0) paintCell(c);
  }

  /** Cells on a straight run, margins only, never on the orbit itself. */
  function path(x0, y0, x1, y1) {
    const out = [];
    const n = Math.ceil(Math.max(Math.abs(x1 - x0) / CW, Math.abs(y1 - y0) / CH));
    for (let s = 1; s <= n; s++) {
      const i = cellOf(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n);
      if (i >= 0 && kind[i] !== 2 && vis[i] > 0.5 && i !== out[out.length - 1]) out.push(i);
    }
    return out;
  }

  /** Where the node parks while waiting on you; in a session, a lead down the margin to the approval card. */
  function waitPlan() {
    const none = { t: brandT(), order: [], end: '' };
    if (view !== 'session' || !G) return none;
    const dc = main.querySelector('#session .dock-col');
    const card = dc && (dc.querySelector(':scope > .approval:not(.leaving)') || dc.querySelector('.composer'));
    const b = card && card.offsetHeight ? boxIn(card, main) : null;
    if (!b) return none;
    const ay = Math.min(b.t + 24, (b.t + b.b) / 2) - G.top;
    const xr = b.r + 36, xl = b.l - 36;
    let e = null, bd = Infinity, right = true;
    for (const r of ring) {
      if (vis[r.i] < 0.6) continue;
      const dr = (r.x - xr) ** 2 + (r.y - ay) ** 2, dl = (r.x - xl) ** 2 + (r.y - ay) ** 2;
      if (Math.min(dr, dl) < bd) (bd = Math.min(dr, dl)), (e = r), (right = dr <= dl);
    }
    if (!e) return none;
    const order = [];
    for (const i of [...path(e.x, e.y, e.x, ay), ...path(e.x, ay, right ? b.r : b.l, ay)]) if (i !== order[order.length - 1]) order.push(i);
    return { t: e.t, order: order.slice(-LEAD), end: right ? '<' : '>' };
  }

  /** Replace the lead; returns the cells it used, so they can be repainted. */
  function setLead(p, shown) {
    const old = leadOrder;
    for (const i of old) lead[i] = 0;
    leadOrder = p.order;
    leadEnd = p.end;
    leadOrder.forEach((i, k) => (lead[i] = k + 1));
    leadShown = shown ? leadOrder.length : 0;
    return old;
  }

  /** The wake: orbit cells the node has just passed turn teal and settle back. Sets `heated` and `seen`. */
  function stepRing() {
    const busy = mode === 'busy' || cruising();
    heated = seen = false;
    for (const e of ring) {
      const i = e.i;
      let h = 0;
      if (busy) {
        const behind = wrap01(nodeT - e.t);
        if (behind < TRAIL) h = (1 - behind / TRAIL) ** 1.6;
      } else if (heat[i]) h = heat[i] * 0.8;
      if (h < 0.03) h = 0;
      if (h !== heat[i] && (h === 0 || heat[i] === 0 || Math.abs(h - heat[i]) > 0.01)) {
        heat[i] = h;
        if (i !== nodeCell && vis[i] > 0.01) paintCell(i);
      }
      if (h) {
        heated = true;
        if (vis[i] > 0.01) seen = true;
      }
    }
  }

  /** While the node is behind the reading column, sleep until it reaches a margin again. */
  function untilVisible() {
    let best = 1;
    for (const e of ring) {
      if (vis[e.i] <= 0.01) continue;
      const d = wrap01(e.t - nodeT);
      if (d > 0 && d < best) best = d;
    }
    return clamp(TICK, best * PERIOD - TICK, 3000);
  }

  function tick() {
    timer = 0;
    if (document.hidden || !geo) return; // visibilitychange restarts it
    const now = performance.now(), dt = Math.min(maxDt, now - last);
    last = now;
    maxDt = 250;
    const still = reduceMq.matches;
    let more = false;
    if (glide) {
      const p = still ? 1 : Math.min(1, (now - glide.t0) / GLIDE);
      setNode(glide.from + glide.d * (1 - (1 - p) ** 3));
      if (p < 1) more = true;
      else glide = null;
    } else if (mode === 'busy' && !still && ringSeen) {
      setNode(nodeT + dt / PERIOD);
      more = true;
    } else if (cruising() && ringSeen) {
      // Home at rest: the node drifts round the orbit slowly, with a neutral wake (teal stays the agent's signal).
      setNode(nodeT + dt / (PERIOD * 2.4));
      more = true;
    }
    stepRing();
    if (heated) {
      if (seen) more = true;
      else if (mode !== 'busy') heat.fill(0); // the rest of the wake is behind the column: nothing to repaint
    }
    if (!glide && leadShown < leadOrder.length) {
      leadShown = still ? leadOrder.length : leadShown + 1;
      if (still) for (const i of leadOrder) paintCell(i);
      else paintCell(leadOrder[leadShown - 1]);
      if (leadShown < leadOrder.length) more = true;
    }
    if (!more || still) return;
    let delay = TICK;
    if (glide || leadShown < leadOrder.length) delay = FAST;
    else if (mode === 'busy' && !seen && !(nodeCell >= 0 && vis[nodeCell] > 0.01)) delay = untilVisible();
    maxDt = delay + 250;
    timer = setTimeout(tick, delay);
  }

  function kick() {
    if (document.hidden || !geo) return;
    if (timer) clearTimeout(timer);
    else (last = performance.now()), (maxDt = 250);
    timer = setTimeout(tick, 0);
  }

  function enterMode() {
    if (!geo) return;
    const p = mode === 'wait' ? waitPlan() : { t: brandT(), order: [], end: '' };
    const still = reduceMq.matches;
    for (const i of setLead(p, still)) paintCell(i);
    if (still) for (const i of leadOrder) paintCell(i);
    glide = mode === 'busy' ? null : { from: nodeT, d: ((p.t - nodeT + 1.5) % 1) - 0.5, t0: performance.now() };
    if (nodeCell >= 0) paintCell(nodeCell); // its colour follows the mode
    kick();
  }

  function syncScroll() {
    const y = view === 'home' && welcome ? welcome.scrollTop : 0;
    canvas.style.transform = y ? `translate3d(0, ${-y}px, 0)` : '';
  }

  function watchDock() {
    const d = view === 'session' ? main.querySelector('#session .dock') : null;
    if (d === dockEl) return;
    if (dockEl) dockRo.unobserve(dockEl);
    if (d) dockRo.observe(d);
    dockEl = d;
  }

  function full(force) {
    if (swapping && !force) return; // the swap rebuilds once the old field has faded out
    readTokens();
    const g = measure();
    if (!g) return;
    const k = keyOf(g);
    if (!force && geo && k === key) return;
    key = k;
    G = g;
    clearTimeout(timer);
    timer = 0;
    build(g);
    glide = null;
    leadOrder = [];
    nodeCell = -1;
    if (mode === 'wait') {
      const p = waitPlan();
      nodeT = p.t;
      setLead(p, true);
    } else {
      setLead({ order: [], end: '' }, true);
      if (mode === 'idle' || reduceMq.matches) nodeT = brandT(); // busy keeps its place on the orbit
    }
    nodeCell = cellAt(nodeT);
    paintAll();
    if (revealNext) {
      revealNext = false;
      startReveal();
    }
    syncScroll();
    watchDock();
    startSpin();
    if (mode === 'busy' || cruising()) {
      if (reduceMq.matches) stepRing();
      else kick();
    }
  }

  function schedule(force) {
    if (force) dirty = true;
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      const f = dirty;
      dirty = false;
      full(f);
    };
    // While a side pane is being dragged, rebuild once it settles rather than on every frame.
    if (document.body.classList.contains('resizing')) setTimeout(run, 140);
    else requestAnimationFrame(run);
  }

  function swap() {
    clearTimeout(swapTimer);
    clearTimeout(timer);
    timer = 0;
    if (reduceMq.matches) {
      swapping = false;
      return full(true);
    }
    swapping = true;
    wrap.classList.remove('on');
    swapTimer = setTimeout(() => {
      swapping = false;
      full(true);
      wrap.classList.add('on');
    }, 160);
  }

  function set() {
    const v = want.view === 'session' ? 'session' : 'home', m = want.mode || 'idle', t = want.tab || '';
    if (v !== view) {
      view = v;
      mode = m;
      tab = t;
      if (v === 'home') revealNext = true;
      return swap();
    }
    if (swapping) return void ((mode = m), (tab = t)); // the rebuild at the end of the swap uses them
    if (t !== tab) {
      tab = t;
      mode = m;
      return schedule(true);
    }
    if (m === mode) return;
    mode = m;
    enterMode();
  }

  /** The approval card or the composer moved (it grows as you type): move the lead with it, only while waiting. */
  function replan() {
    dockRaf = 0;
    if (mode !== 'wait' || view !== 'session' || !geo || swapping) return;
    const p = waitPlan();
    if (p.order.join() === leadOrder.join() && cellAt(p.t) === cellAt(nodeT)) return;
    enterMode();
  }

  // ---- Planet (Home): Lambert shading from the top left, times a surface texture that drifts east as it turns. ----
  /** Write the planet cells' characters for time `now`; returns the cells whose look changed. */
  // Surface: continents (dense glyphs, the ring's ink) on oceans (wave glyphs, the field's ink), a cloud layer that
  // turns a little faster than the ground, Lambert light from the top left with limb darkening and a specular glint,
  // and on the night side a scatter of faint warm lights over land. Colour per cell: 0 ring ink, 1 field ink, 2 warm.
  const LAND = ['.', ':', '+', '*', '#', '%'];
  const SEA = ['.', '·', ':', ';']; // dots only: at 9 px '~' and '-' both read as dashes, and rows of them as scanlines
  function shadePlanet(now) {
    const changed = [];
    const ph = now / SPIN;
    for (const p of planet) {
      if (kind[p.i] !== 3) continue; // the near orbit crosses the planet there
      const ndl = p.nx * LIGHT[0] + p.ny * LIGHT[1] + p.nz * LIGHT[2];
      const day = smooth(-0.08, 0.22, ndl); // a soft terminator, not a hard edge
      const lit = Math.max(0, ndl);
      const limb = 0.5 + 0.5 * p.nz;
      const ang = Math.atan2(p.nx, p.nz) / TAU;
      const lon = ang + ph, lat = p.ny;
      // Longitude moves ~1/TAU per unit across the disc, latitude 1 per unit down it: scale longitude ~6x so the
      // continents come out round, not smeared into horizontal bands.
      const landN = noise(lon * 15, lat * 2.4 + 1) * 0.62 + noise(lon * 40 + 3, lat * 6.5) * 0.38;
      const land = landN > 0.55;
      // Clouds are rounded puffs (similar frequency across and along), so they never streak into horizontal bands.
      const ca = ang + ph * 1.45;
      const cloudN = noise(ca * 26 + 9, lat * 4.2 + 2) * 0.7 + noise(ca * 62, lat * 10) * 0.3;
      const cloud = cloudN > 0.66 && hash(p.i, 17) < 0.8;
      const spec = lit ** 18 * 0.9;
      let ch = '', a = 0, col = 0;
      if (cloud && day > 0.15) {
        ch = cloudN > 0.75 ? 'o' : cloudN > 0.7 ? '°' : '·';
        a = (0.12 + 0.3 * lit) * limb * day;
      } else if (day > 0.04) {
        const v = clamp(0, (lit * (land ? 0.92 : 0.6) + spec) * limb, 0.97);
        if (land) ch = LAND[Math.min(LAND.length - 1, (v * LAND.length) | 0)];
        // Oceans are dithered (a fixed pattern per cell, so it does not flicker): open water reads as texture.
        else if (hash(p.i, 13) < 0.35 + 0.4 * v) (ch = SEA[Math.min(SEA.length - 1, (v * SEA.length) | 0)]), (col = 1);
        a = (0.04 + 0.3 * v) * day;
      } else if (land && hash(p.i, 31) < 0.11) {
        // Night side: a few lights over land, steady (not twinkling), very faint.
        ch = '·';
        col = 2;
        a = 0.22;
      }
      a *= p.q * C.mul;
      if (a < 0.012) ch = '';
      if (ch !== base[p.i] || col !== pcol[p.i] || Math.abs(a - alpha[p.i]) > 0.02) {
        base[p.i] = ch;
        alpha[p.i] = a;
        pcol[p.i] = col;
        changed.push(p.i);
      }
    }
    return changed;
  }
  /** Ring texture for time `now`: particles stream along each band (angular noise that drifts), denser toward the
   *  middle of a band, brighter on the lit side and where the ring crosses in front of the planet. */
  function shadeRings(now) {
    const changed = [];
    const t = now / RING_SPIN;
    for (const r of rings) {
      if (kind[r.i] !== 5) continue;
      const [a, b, s] = RING_BANDS[r.band];
      const mid = 1 - Math.abs((r.e - a) / (b - a) - 0.5) * 2; // 0 at a band's edge, 1 in its middle
      const u = r.th / TAU + t * (1.25 - r.e * 0.3); // inner particles move faster, like a real ring
      const n = noise(u * 70 + r.band * 13, r.e * 40) * 0.7 + noise(u * 190, r.e * 90 + 5) * 0.3;
      // Mostly the band's own strength (so each band reads as one clean stripe), with a little streaming texture.
      const v = clamp(0, s * (0.6 + 0.4 * mid) * (0.78 + 0.34 * n) * (0.62 + 0.48 * r.side), 1);
      let ch = '';
      if (v > 0.08 && hash(r.i, 23) < 0.82 + 0.18 * v) ch = RING_CH[Math.min(RING_CH.length - 1, (v * RING_CH.length) | 0)];
      let al = (0.08 + 0.46 * v) * (r.front ? 1.15 : 1) * r.q * C.mul;
      const col = s < 0.45 ? 1 : 0; // the faint rings in the field's ink, the bright ones in the ring's
      if (al < 0.012) (ch = ''), (al = 0);
      if (ch !== base[r.i] || col !== pcol[r.i] || Math.abs(al - alpha[r.i]) > 0.02) {
        base[r.i] = ch;
        alpha[r.i] = al;
        pcol[r.i] = col;
        changed.push(r.i);
      }
    }
    return changed;
  }
  function spin() {
    spinTimer = 0;
    if (document.hidden || reduceMq.matches || view !== 'home' || !planet.length || swapping) return;
    const now = performance.now();
    for (const i of shadePlanet(now)) if (i !== nodeCell) paintCell(i);
    for (const i of shadeRings(now)) if (i !== nodeCell) paintCell(i);
    spinLast = now;
    spinTimer = setTimeout(spin, 150);
  }
  function startSpin() {
    if (!spinTimer && view === 'home' && planet.length && !reduceMq.matches) spinTimer = setTimeout(spin, 150);
  }

  // ---- Lens: the pointer lights the type around it; the light decays over ~0.6 s. Only lit cells are repainted. ----
  const LENS_R = 96, DECAY = 0.84, LENS_STEP = 33, LENS_PEAK = 0.8;
  function light(x, y, r, peak) {
    if (!geo || !cols) return;
    const c0 = Math.max(0, Math.floor((x - r - offX) / CW)), c1 = Math.min(cols - 1, Math.floor((x + r - offX) / CW));
    const r0 = Math.max(0, Math.floor((y - r) / CH)), r1 = Math.min(rows - 1, Math.floor((y + r) / CH));
    for (let rr = r0; rr <= r1; rr++) {
      for (let cc = c0; cc <= c1; cc++) {
        const i = rr * cols + cc;
        if (vis[i] < 0.05) continue;
        const dx = offX + cc * CW + CW / 2 - x, dy = (rr * CH + CH / 2 - y) * 1.15;
        const d = Math.hypot(dx, dy) / r;
        if (d >= 1) continue;
        const v = peak * (1 - d) ** 1.6;
        if (v > glow[i] + 0.02) {
          glow[i] = v;
          lit.add(i);
        }
      }
    }
    if (lit.size && !lensRaf) lensRaf = requestAnimationFrame(lensFrame);
  }
  function lensFrame(now) {
    lensRaf = 0;
    if (now - lensLast < LENS_STEP) {
      lensRaf = requestAnimationFrame(lensFrame);
      return;
    }
    lensLast = now;
    frame++;
    for (const i of lit) {
      glow[i] *= DECAY;
      if (glow[i] < 0.02) {
        glow[i] = 0;
        lit.delete(i);
      }
      paintCell(i);
    }
    if (lit.size) lensRaf = requestAnimationFrame(lensFrame);
  }
  function onPointer(e) {
    if (reduceMq.matches || !G || e.pointerType === 'touch') return;
    const r = main.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top - G.top + (view === 'home' && welcome ? welcome.scrollTop : 0);
    if (y < 0) return;
    light(x, y, LENS_R, LENS_PEAK);
  }
  main.addEventListener('pointermove', onPointer, { passive: true });
  // Idle shimmer on Home: now and then a few glyphs catch the light and settle again. Never under reduced motion,
  // never while the window is hidden, never in a session (the reading view stays still).
  function shimmer() {
    if (document.hidden || reduceMq.matches || view !== 'home' || !geo || swapping) return;
    {
      const i = (Math.random() * base.length) | 0;
      if (!base[i] || vis[i] < 0.5) return;
      glow[i] = Math.max(glow[i], 0.42);
      lit.add(i);
    }
    if (lit.size && !lensRaf) lensRaf = requestAnimationFrame(lensFrame);
  }
  shimmerTimer = setInterval(shimmer, 260);

  const ro = new ResizeObserver(() => schedule(false));
  ro.observe(main);
  const dockRo = new ResizeObserver(() => dockRaf || (dockRaf = requestAnimationFrame(replan)));
  new MutationObserver(() => schedule(false)).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', () => !document.hidden && (kick(), startSpin()));
  reduceMq.addEventListener('change', () => schedule(true));
  welcome?.addEventListener('scroll', () => view === 'home' && syncScroll(), { passive: true });
  (function watchDpr() {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => (schedule(false), watchDpr()), { once: true });
  })();
  document.fonts?.load(FONT).then(() => schedule(true), () => {});

  full(true);
  requestAnimationFrame(() => wrap.classList.add('on'));
  return { set, refresh: () => schedule(false) };
}
