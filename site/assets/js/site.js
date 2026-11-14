// ORBIX website motion. Loaded in <head> so the page is marked as scripted (html.js) before it paints; everything
// else waits for the document. Without this file, or with reduced motion, the page is complete and still.
document.documentElement.classList.add('js');

(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function ready() {
    topBar();
    splitWords();
    reveals();
    terminal();
    gallery();
    tilt();
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
              w.style.setProperty('--d', `${(i++ * 0.05).toFixed(2)}s`);
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
      el.style.setProperty('--d', `${Math.min(n, 6) * 0.05 + (el.closest('.hero') ? 0.3 : 0)}s`);
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach((e) => io.observe(e));
  }

  /* The hero session plays line by line, typing your message first, then starts over. */
  function terminal() {
    const body = document.querySelector('.term-body');
    if (!body || reduced) return;
    const lines = [...body.children];
    const you = lines[0];
    const label = you.querySelector('b');
    const text = you.textContent.slice(label.textContent.length).trim();
    const typed = document.createElement('span');
    const caret = document.createElement('i');
    caret.className = 'caret';
    you.replaceChildren(label, typed, caret);
    const pause = [0, 650, 550, 650, 400, 300, 800, 1600, 500];
    let timers = [];
    let running = false;
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));
    const play = () => {
      running = true;
      timers.forEach(clearTimeout);
      timers = [];
      body.classList.add('play');
      lines.forEach((l) => l.classList.remove('on'));
      typed.textContent = '';
      caret.hidden = false;
      you.classList.add('on');
      let t = 300;
      for (let i = 0; i < text.length; i++) later(() => (typed.textContent = text.slice(0, i + 1)), (t += 24 + Math.random() * 30));
      later(() => (caret.hidden = true), (t += 250));
      for (let i = 1; i < lines.length; i++) later(() => lines[i].classList.add('on'), (t += pause[i]));
      later(play, t + 5200);
    };
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !running) play();
      if (!e.isIntersecting && running) {
        running = false;
        timers.forEach(clearTimeout);
        body.classList.remove('play');
        caret.hidden = true;
        typed.textContent = text;
      }
    }, { threshold: 0.3 });
    io.observe(body);
  }

  /* Screens: tabs with arrow keys, as a tab list should work. */
  function gallery() {
    const tabs = [...document.querySelectorAll('.g-tabs [role=tab]')];
    const pick = (t, focus) => {
      for (const x of tabs) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls'))?.classList.toggle('on', on);
      }
      if (focus) t.focus();
    };
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => pick(t));
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        pick(tabs[(i + d + tabs.length) % tabs.length], true);
      });
    });
  }

  /* The big screenshot leans back and stands up as it scrolls in. */
  function tilt() {
    const els = [...document.querySelectorAll('[data-tilt] img')];
    if (!els.length || reduced) return;
    let queued = false;
    const set = () => {
      queued = false;
      const vh = innerHeight;
      for (const img of els) {
        const r = img.parentElement.getBoundingClientRect();
        const p = clamp((vh - r.top) / (vh * 0.85), 0, 1);
        const e = 1 - Math.pow(1 - p, 2);
        img.style.setProperty('--tilt', `${((1 - e) * 14).toFixed(2)}deg`);
        img.style.setProperty('--sc', (0.95 + 0.05 * e).toFixed(3));
      }
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(set); } }, { passive: true });
    addEventListener('resize', set);
    set();
  }

  /*
   * The orbit field: a planet of points and a tilted ring around it, as in the ORBIX mark, drawn in perspective.
   * A signal travels along the ring in the accent colour. The pointer pushes points away and they spring back.
   * Drawing stops while the canvas is off screen or the tab is hidden.
   */
  function orbit(canvas, small) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const FG = css.getPropertyValue('--fg').trim() || '#F3F3EF';
    const AC = css.getPropertyValue('--accent').trim() || '#D4FF4F';
    let W = 0, H = 0, dpr = 1, R = 100, cx = 0, cy = 0;
    let pts = [];
    let visible = true;
    let raf = 0;
    const mouse = { x: -1e4, y: -1e4 };

    const build = () => {
      const narrow = W < 700;
      const k = (small ? 0.55 : 1) * (narrow ? 0.55 : 1);
      pts = [];
      const nS = Math.round(1100 * k);
      const ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < nS; i++) {
        const y = 1 - (i / (nS - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        pts.push({ kind: 0, x: Math.cos(ga * i) * r, y, z: Math.sin(ga * i) * r, ox: 0, oy: 0 });
      }
      const nR = Math.round(1300 * k);
      for (let i = 0; i < nR; i++) {
        const a = Math.random() * Math.PI * 2;
        const rad = 1.45 + Math.pow(Math.random(), 1.8) * 0.6;
        pts.push({ kind: 1, a, rad, h: (Math.random() - 0.5) * 0.05, ox: 0, oy: 0 });
      }
      const nD = Math.round(220 * k);
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
      R = small ? Math.min(W * 0.14, H * 0.24) : Math.min(W * 0.24, H * 0.34, 330);
      cx = W / 2;
      cy = small ? H * 0.5 : Math.min(H * 0.4, 380);
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
      const base = small ? 0.75 : 1;
      for (const p of pts) {
        let x, y, z, al, accent = false, sz = 1.3;
        if (p.kind === 0) {
          x = p.x * cs + p.z * ss; z = -p.x * ss + p.z * cs; y = p.y;
          // tip toward the viewer as the page scrolls
          const y2 = y * cl - z * sl; z = y * sl + z * cl; y = y2;
          // rim-lit: the edge of the planet is bright, its face stays quiet behind the headline
          const rim = 1 - Math.abs(z);
          al = (0.04 + 0.62 * Math.pow(rim, 2.4)) * (z > 0 ? 0.45 : 1);
          sz = 1.7;
        } else if (p.kind === 1) {
          const a = p.a + spin * 1.6 / p.rad;
          let rx = Math.cos(a) * p.rad, ry = p.h, rz = Math.sin(a) * p.rad;
          // lean back, then tilt in the screen plane
          const ry2 = ry * cL - rz * sL; rz = ry * sL + rz * cL; ry = ry2;
          x = rx * cT - ry * sT; y = rx * sT + ry * cT; z = rz;
          const y2 = y * cl - z * sl; z = y * sl + z * cl; y = y2;
          const behind = (((head - a) % 6.2832) + 6.2832) % 6.2832;
          accent = behind < 1.1;
          al = accent ? 0.3 + 0.55 * (1 - behind / 1.1) : 0.14 + 0.4 * clamp((1 - z / 2.4) / 2, 0, 1);
          sz = accent ? 1.9 : 1.4;
        } else {
          x = p.x; y = p.y; z = p.z;
          p.tw += dt * 1.4;
          al = 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(p.tw));
          sz = 1;
        }
        const s = F / (D + z) / R;
        let sx = cx + x * R * s, sy = cy + y * R * s;
        // ring points behind the planet are hidden by it
        if (p.kind === 1 && z > 0 && Math.hypot(x, y) < 1) al *= 0.08;
        // the pointer pushes points away; they spring back
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
    const host = canvas.parentElement;
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
