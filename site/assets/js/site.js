// ORBIX website. Small and optional: the page is complete without it. Header state, the narrow-screen menu, the
// permission and screen tabs (WAI-ARIA, arrow keys, Home, End), the copy buttons, the current section in the header,
// the colour theme switch and the hero's dot field.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function topBar() {
    const top = document.querySelector('.top');
    if (!top) return;
    const set = () => top.classList.toggle('scrolled', scrollY > 8);
    set();
    addEventListener('scroll', set, { passive: true });
  }

  function menu() {
    const m = document.querySelector('details.menu');
    if (!m) return;
    const close = () => { m.open = false; };
    m.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.open) { close(); m.querySelector('summary').focus(); }
    });
    document.addEventListener('click', (e) => { if (m.open && !m.contains(e.target)) close(); });
    matchMedia('(min-width: 1081px)').addEventListener('change', (e) => { if (e.matches) close(); });
  }

  function tabs(list, onPick) {
    const all = [...list.querySelectorAll('[role=tab]')];
    const pick = (t, focus) => {
      for (const o of all) {
        const on = o === t;
        o.setAttribute('aria-selected', String(on));
        o.tabIndex = on ? 0 : -1;
      }
      onPick(t);
      if (focus) {
        t.focus();
        t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced.matches ? 'auto' : 'smooth' });
      }
    };
    for (const t of all) {
      t.addEventListener('click', () => pick(t, false));
      t.addEventListener('keydown', (e) => {
        const i = all.indexOf(t);
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        pick(all[(to + all.length) % all.length], true);
      });
    }
    return pick;
  }

  function permissions() {
    const perm = document.querySelector('.perm');
    const list = perm?.querySelector('[role=tablist]');
    if (!list) return;
    tabs(list, (t) => {
      perm.classList.remove('mode-ask', 'mode-edits', 'mode-safe', 'mode-auto');
      perm.classList.add('mode-' + t.dataset.mode);
      perm.querySelector('[role=tabpanel]')?.setAttribute('aria-labelledby', t.id);
    });
  }

  function gallery() {
    const list = document.querySelector('.g-tabs');
    if (!list) return;
    tabs(list, (t) => {
      for (const f of document.querySelectorAll('.g-view [role=tabpanel]')) f.classList.toggle('on', f.id === t.getAttribute('aria-controls'));
    });
    // Load every screen once the gallery is near, so switching tabs never shows an empty frame.
    const imgs = [...document.querySelectorAll('.g-view img[loading=lazy]')];
    const eager = () => { for (const i of imgs) i.loading = 'eager'; };
    if (!('IntersectionObserver' in window)) return eager();
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { eager(); io.disconnect(); } }, { rootMargin: '800px 0px' });
    io.observe(list);
  }

  function copy() {
    for (const b of document.querySelectorAll('[data-copy]')) {
      const label = b.querySelector('.copy-l');
      const status = document.createElement('span');
      status.className = 'sr-status';
      status.setAttribute('role', 'status');
      b.after(status);
      let timer;
      b.addEventListener('click', async () => {
        const text = document.getElementById(b.dataset.copy)?.textContent.trim() || '';
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch {
          const sel = getSelection(); const r = document.createRange();
          r.selectNodeContents(document.getElementById(b.dataset.copy)); sel.removeAllRanges(); sel.addRange(r);
        }
        b.classList.toggle('done', ok);
        if (label) label.textContent = ok ? 'Copied' : 'Selected';
        status.textContent = ok ? 'Command copied' : 'Command selected. Press Ctrl+C to copy.';
        clearTimeout(timer);
        timer = setTimeout(() => { b.classList.remove('done'); if (label) label.textContent = 'Copy'; status.textContent = ''; }, 2200);
      });
    }
  }


  // Which section you are in, shown in the header.
  function current() {
    const links = [...document.querySelectorAll('.top-nav a[href^="#"]')];
    const map = new Map(links.map((a) => [document.getElementById(a.hash.slice(1)), a]));
    if (!links.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links) a.removeAttribute('aria-current');
        map.get(e.target)?.setAttribute('aria-current', 'true');
      }
    }, { rootMargin: '-45% 0px -50% 0px' });
    for (const s of map.keys()) if (s) io.observe(s);
    // Back above the first section (the hero), nothing is current.
    const hero = document.querySelector('.hero');
    if (hero) io.observe(hero);
  }



  // The footer's colour theme: System (follow the device), Light or Dark, remembered on this browser.
  function themeSwitch() {
    const seg = document.querySelector('.theme-seg');
    if (!seg) return;
    const root = document.documentElement;
    const btns = [...seg.querySelectorAll('[data-theme-pick]')];
    const show = () => {
      const cur = root.dataset.theme || 'system';
      for (const b of btns) {
        const on = b.dataset.themePick === cur;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };
    const set = (v, focus) => {
      if (v === 'system') delete root.dataset.theme;
      else root.dataset.theme = v;
      try { v === 'system' ? localStorage.removeItem('orbix-site-theme') : localStorage.setItem('orbix-site-theme', v); } catch {}
      show();
      if (focus) btns.find((b) => b.dataset.themePick === v)?.focus();
    };
    for (const b of btns) {
      b.addEventListener('click', () => set(b.dataset.themePick));
      b.addEventListener('keydown', (e) => {
        const i = btns.indexOf(b);
        const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        set(btns[(to + btns.length) % btns.length].dataset.themePick, true);
      });
    }
    show();
  }


  // A field of square dots, brighter where slow waves meet; a few of the brightest turn green. Drawn on a canvas at
  // most 30 times a second, only while it is on screen and the tab is visible. One still frame with reduced motion.
  function field() {
    for (const c of document.querySelectorAll('canvas[data-field]')) {
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      const soft = c.dataset.field === 'soft';
      const STEP = 11, SIZE = 2;
      let w = 0, h = 0, dpr = 1, visible = true, raf = 0, last = 0, t0 = performance.now();
      const col = () => {
        const cs = getComputedStyle(document.documentElement);
        return { dot: cs.getPropertyValue('--dot').trim() || '232,240,235', hi: cs.getPropertyValue('--dot-hi').trim() || '61,242,140' };
      };
      let colors = col();
      const size = () => {
        const r = c.getBoundingClientRect();
        dpr = Math.min(devicePixelRatio || 1, 1.5);
        w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      const LEVELS = 6;
      const draw = (now) => {
        const t = (now - t0) / 1000;
        ctx.clearRect(0, 0, w, h);
        const buckets = Array.from({ length: LEVELS }, () => []);
        const hi = [];
        const cols = Math.ceil(w / STEP), rows = Math.ceil(h / STEP);
        const narrow = w < 760;
        for (let j = 0; j < rows; j++) {
          const y = j * STEP;
          for (let i = 0; i < cols; i++) {
            const x = i * STEP;
            // Where the field lives: the right of the hero on wide screens, the top on narrow ones, all over when soft.
            const m = soft ? 0.8 : narrow ? 1.05 - y / h * 1.15 : Math.min(1.1, Math.max(0, (x / w - 0.18) * 1.6)) * (0.55 + 0.45 * (1 - Math.abs(y / h - 0.42)));
            if (m <= 0.02) continue;
            const v = Math.sin(x * 0.011 + t * 0.55) + Math.sin(y * 0.017 - t * 0.42) + Math.sin((x - y) * 0.006 + t * 0.3) + Math.sin(Math.hypot(x - w * 0.72, y - h * 0.4) * 0.018 - t * 0.9);
            const n = (v / 4 + 0.5) * m;
            if (n < 0.3) continue;
            if (n > 0.74 && ((i * 7 + j * 13) % 4 === 0)) { hi.push(x, y); continue; }
            buckets[Math.min(LEVELS - 1, Math.floor((n - 0.3) / 0.6 * LEVELS))].push(x, y);
          }
        }
        for (let k = 0; k < LEVELS; k++) {
          const b = buckets[k];
          if (!b.length) continue;
          ctx.fillStyle = `rgba(${colors.dot},${(0.1 + k * 0.09) * (soft ? 0.7 : 1)})`;
          for (let q = 0; q < b.length; q += 2) ctx.fillRect(b[q], b[q + 1], SIZE, SIZE);
        }
        ctx.fillStyle = `rgba(${colors.hi},${soft ? 0.5 : 0.85})`;
        for (let q = 0; q < hi.length; q += 2) ctx.fillRect(hi[q], hi[q + 1], SIZE, SIZE);
      };
      const loop = (now) => {
        raf = 0;
        if (!visible || document.hidden) return;
        if (now - last >= 33) { last = now; draw(now); }
        raf = requestAnimationFrame(loop);
      };
      const start = () => { if (!raf && !reduced.matches) raf = requestAnimationFrame(loop); };
      size(); draw(performance.now());
      new ResizeObserver(() => { size(); draw(performance.now()); }).observe(c);
      if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }, { rootMargin: '100px' }).observe(c);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
      reduced.addEventListener('change', () => { if (reduced.matches) { cancelAnimationFrame(raf); raf = 0; } else start(); });
      new MutationObserver(() => { colors = col(); draw(performance.now()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { colors = col(); draw(performance.now()); });
      start();
    }
  }

  function ready() { topBar(); menu(); permissions(); gallery(); copy(); current(); themeSwitch(); field(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
