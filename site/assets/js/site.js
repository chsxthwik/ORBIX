// ORBIX website. Small and optional: the page is complete without it. Header state, the narrow-screen menu, the
// permission and screen tabs (WAI-ARIA, arrow keys, Home, End), the copy button, scroll reveals, the current
// section in the header and a pointer light on cards.
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
        status.textContent = ok ? 'Install command copied' : 'Install command selected. Press Ctrl+C to copy.';
        clearTimeout(timer);
        timer = setTimeout(() => { b.classList.remove('done'); if (label) label.textContent = 'Copy'; status.textContent = ''; }, 2200);
      });
    }
  }

  function reveals() {
    if (reduced.matches || !('IntersectionObserver' in window)) return;
    const els = [...document.querySelectorAll('[data-reveal]')];
    const below = els.filter((el) => el.getBoundingClientRect().top > innerHeight * 0.92);
    if (!below.length) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { rootMargin: '0px 0px -8% 0px' });
    document.documentElement.classList.add('reveal-on');
    for (const el of els) {
      if (below.includes(el)) io.observe(el); else el.classList.add('in');
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

  // A soft light that follows the pointer across a card. Mouse only.
  function spotlight() {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    for (const grid of document.querySelectorAll('.bento')) {
      grid.addEventListener('pointermove', (e) => {
        const card = e.target.closest('.card');
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      }, { passive: true });
    }
  }

  // The hero's two satellites stop when the hero is off screen.
  function idle() {
    const hero = document.querySelector('.hero');
    if (!hero || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(([e]) => hero.classList.toggle('away', !e.isIntersecting)).observe(hero);
  }

  function ready() { topBar(); menu(); permissions(); gallery(); copy(); reveals(); current(); spotlight(); idle(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
