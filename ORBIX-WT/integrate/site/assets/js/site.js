// ORBIX website motion. Loaded in <head> so the page is marked as scripted (html.js) before it paints; everything
// else waits for the document. Without this file, or with reduced motion, the page is complete and still.
// Styles are only ever set through the CSSOM (custom properties), which the site's CSP allows.
document.documentElement.classList.add('js');

(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function ready() {
    topBar();
    menu();
    splitWords();
    reveals();
    tabs('.g-tabs', (tab, on) => document.getElementById(tab.getAttribute('aria-controls'))?.classList.toggle('on', on));
    tabs('.seg', (tab, on) => {
      if (!on) return;
      const perm = tab.closest('.perm');
      perm.classList.remove('mode-ask', 'mode-edits', 'mode-auto');
      perm.classList.add(`mode-${tab.dataset.mode}`);
      perm.querySelector('[role=tabpanel]')?.setAttribute('aria-labelledby', tab.id);
    });
    tilt();
    spotlight();
    for (const c of document.querySelectorAll('canvas.orbit')) orbit(c, c.classList.contains('small'));
  }

  /* The top bar gets a surface once the page scrolls. */
  function topBar() {
    const top = document.querySelector('.top');
    if (!top) return;
    const set = () => top.classList.toggle('scrolled', scrollY > 8);
    addEventListener('scroll', set, { passive: true });
    set();
  }

  /* The small-screen menu closes after a choice, on Escape and on a click elsewhere. */
  function menu() {
    const m = document.querySelector('details.menu');
    if (!m) return;
    const close = () => m.removeAttribute('open');
    m.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && m.open) { close(); m.querySelector('summary').focus(); } });
    document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) close(); });
  }

  /* The headline arrives word by word. */
  function splitWords() {
    for (const el of document.querySelectorAll('[data-split]')) {
      let i = 0;
      const walk = (node) => {
        for (const n of [...node.childNodes]) {
          if (n.nodeType === 3) {
            const frag = document.createDocumentFragment();
            for (const part of n.nodeValue.split(/(\s+)/)) {
              if (!part) continue;
              if (/^\s+$/.test(part)) { frag.append(part); continue; }
              const w = document.createElement('span');
              w.className = 'w';
              w.textContent = part;
              w.style.setProperty('--d', `${(0.08 + i++ * 0.06).toFixed(2)}s`);
              frag.append(w);
            }
            n.replaceWith(frag);
          } else if (n.nodeType === 1) walk(n);
        }
      };
      walk(el);
      el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    }
  }

  /* Blocks fade up as they enter the screen, staggered within their group. */
  function reveals() {
    const els = [...document.querySelectorAll('[data-reveal]')];
    if (reduced || !('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
    const groups = new Map();
    for (const el of els) {
      const k = el.parentElement;
      const n = groups.get(k) || 0;
      groups.set(k, n + 1);
      el.style.setProperty('--d', `${Math.min(n, 6) * 0.06 + (el.closest('.hero') ? 0.35 : 0)}s`);
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    els.forEach((e) => io.observe(e));
  }

  /* A tab list as it should work: one tab stop, arrow keys, Home and End. */
  function tabs(sel, apply) {
    for (const list of document.querySelectorAll(sel)) {
      const all = [...list.querySelectorAll('[role=tab]')];
      const pick = (t, focus) => {
        for (const x of all) {
          const on = x === t;
          x.setAttribute('aria-selected', String(on));
          x.tabIndex = on ? 0 : -1;
          apply(x, on);
        }
        if (focus) { t.focus(); t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      };
      all.forEach((t, i) => {
        t.addEventListener('click', () => pick(t));
        t.addEventListener('keydown', (e) => {
          const n = all.length;
          const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: n - 1 }[e.key];
          if (j === undefined) return;
          e.preventDefault();
          pick(all[(j + n) % n], true);
        });
      });
    }
  }

  /* The hero window leans back and stands up as it scrolls in. */
  function tilt() {
    const els = [...document.querySelectorAll('[data-tilt] .window')];
    if (!els.length || reduced) return;
    let queued = false;
    const set = () => {
      queued = false;
      const vh = innerHeight;
      for (const w of els) {
        const r = w.getBoundingClientRect();
        const p = clamp((vh - r.top) / (vh * 0.8), 0, 1);
        const e = 1 - Math.pow(1 - p, 2);
        w.style.setProperty('--tilt', `${((1 - e) * 16).toFixed(2)}deg`);
        w.style.setProperty('--sc', (0.94 + 0.06 * e).toFixed(3));
      }
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(set); } }, { passive: true });
    addEventListener('resize', set);
    set();
  }

  /* Feature cards carry a faint light under the pointer. */
  function spotlight() {
    if (!matchMedia('(hover: hover)').matches) return;
    for (const card of document.querySelectorAll('.bento .card')) {
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
        card.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
      });
    }
  }

  /*
   * The orbit field: a planet of points and a tilted ring around it, as in the ORBIX mark, drawn in perspective.
   * A signal travels along the ring in the accent colour. The pointer pushes points away and they spring back.
   * Drawing stops while the canvas is off screen or the tab is hidden. Colours come from the page's theme tokens.
   */
  function orbit(canvas, small) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scheme = matchMedia('(prefers-color-scheme: light)');
    let FG, AC, tone;
    const colours = () => {
      const css = getComputedStyle(document.documentElement);
      FG = css.getPropertyValue('--orbit-fg').trim() || '#E9E9E7';
      AC = css.getPropertyValue('--orbit-accent').trim() || '#D4FF4F';
      tone = scheme.matches ? 0.7 : 1;
    };
    colours();
    let W = 0, H = 0, dpr = 1, R = 100, cx = 0, cy = 0;
    let pts = [];
    let visible = true;
    let raf = 0;
    const mouse = { x: -1e4, y: -1e4 };

    const build = () => {
      const k = (small ? 0.55 : 1) * (W < 700 ? 0.55 : 1);
      pts = [];
      const nS = Math.round(950 * k);
      const ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < nS; i++) {
        const y = 1 - (i / (nS - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        pts.push({ kind: 0, x: Math.cos(ga * i) * r, y, z: Math.sin(ga * i) * r, ox: 0, oy: 0 });
      }
      const nR = Math.round(1150 * k);
      for (let i = 0; i < nR; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = 1.45 + Math.pow(Math.random(), 1.8) * 0.6;
        pts.push({ kind: 1, a, rad, h: (Math.random() - 0.5) * 0.05, ox: 0, oy: 0 });
      }
      const nD = Math.round(180 * k);
      for (let i = 0; i < nD; i++) {
        pts.push({ kind: 2, x: (Math.random() - 0.5) * 7, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4, ox: 0, oy: 0, tw: Math.random() * 6.28 });
      }
    };

    const size = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, devicePixelRatio || 1);
      const w = Math.round(r.width), h = Math.round(r.height);
      const rebuild = Math.abs(w - W) > 120 || !pts.length;
      W = w; H = h;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      R = small ? Math.min(W * 0.13, H * 0.22) : Math.min(W * 0.24, H * 0.3, 320);
      cx = W / 2;
      cy = small ? H * 0.5 : Math.min(H * 0.34, 330);
      if (rebuild) build();
    };

    // Ring orientation: tilted like the logo (about -24 degrees) and seen from slightly above.
    const TILT = (-24 * Math.PI) / 180;
    const LEAN = (72 * Math.PI) / 180;
    const cT = Math.cos(TILT), sT = Math.sin(TILT), cL = Math.cos(LEAN), sL = Math.sin(LEAN);

    let last = performance.now();
    let spin = 0;
    let head = 0;
    const frame = (now) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      spin += dt * 0.12;
      head += dt * 0.9;
      const scrollLean = small ? 0 : Math.min(0.35, scrollY / 2400);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const D = 4.2;
      const F = R * 3.6;
      const cs = Math.cos(spin), ss = Math.sin(spin);
      const cl = Math.cos(scrollLean), sl = Math.sin(scrollLean);
      const base = (small ? 0.6 : 0.85) * tone;
      for (const p of pts) {
        let x, y, z, al, accent = false, sz = 1.3;
        if (p.kind === 0) {
          x = p.x * cs + p.z * ss; z = -p.x * ss + p.z * cs; y = p.y;
          const y2 = y * cl - z * sl; z = y * sl + z * cl; y = y2;
          // rim-lit: the edge of the planet is bright, its face stays quiet behind the headline
          const rim = 1 - Math.abs(z);
          al = (0.03 + 0.6 * Math.pow(rim, 2.4)) * (z > 0 ? 0.4 : 1);
          sz = 1.7;
        } else if (p.kind === 1) {
          const a = p.a + spin * 1.6 / p.rad;
          let rx = Math.cos(a) * p.rad, ry = p.h, rz = Math.sin(a) * p.rad;
          const ry2 = ry * cL - rz * sL; rz = ry * sL + rz * cL; ry = ry2;
          x = rx * cT - ry * sT; y = rx * sT + ry * cT; z = rz;
          const y2 = y * cl - z * sl; z = y * sl + z * cl; y = y2;
          const behind = (((head - a) % 6.2832) + 6.2832) % 6.2832;
          accent = behind < 1.1;
          al = accent ? 0.3 + 0.55 * (1 - behind / 1.1) : 0.12 + 0.36 * clamp((1 - z / 2.4) / 2, 0, 1);
          sz = accent ? 1.9 : 1.4;
        } else {
          x = p.x; y = p.y; z = p.z;
          p.tw += dt * 1.4;
          al = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(p.tw));
          sz = 1;
        }
        const s = F / (D + z) / R;
        let sx = cx + x * R * s, sy = cy + y * R * s;
        if (p.kind === 1 && z > 0 && Math.hypot(x, y) < 1) al *= 0.08;
        const dx = sx - mouse.x, dy = sy - mouse.y, d2 = dx * dx + dy * dy, RR = 130 * 130;
        let tx = 0, ty = 0;
        if (d2 < RR) { const f = (1 - d2 / RR) * 34 / (Math.sqrt(d2) + 1); tx = dx * f; ty = dy * f; }
        p.ox += (tx - p.ox) * 0.12; p.oy += (ty - p.oy) * 0.12;
        sx += p.ox; sy += p.oy;
        if (sx < -4 || sy < -4 || sx > W + 4 || sy > H + 4) continue;
        ctx.globalAlpha = al * base;
        ctx.fillStyle = accent ? AC : FG;
        const q = sz * Math.min(1.5, s);
        ctx.beginPath();
        ctx.arc(sx, sy, q / 2, 0, 6.2832);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduced) loop();
    };
    const loop = () => { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame); };

    size();
    addEventListener('resize', () => { size(); if (reduced) frame(performance.now()); }, { passive: true });
    scheme.addEventListener?.('change', () => { colours(); if (reduced) frame(performance.now()); });
    const host = canvas.closest('section') || canvas.parentElement;
    host.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; });
    host.addEventListener('pointerleave', () => { mouse.x = mouse.y = -1e4; });
    if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) { last = performance.now(); loop(); } }).observe(canvas);
    document.addEventListener('visibilitychange', () => { last = performance.now(); loop(); });
    if (reduced) frame(performance.now());
    else loop();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
