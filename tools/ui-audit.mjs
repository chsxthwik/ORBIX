// The interface audit: what the page in front of it breaks of the design rules, read from the rendered page (computed
// styles, so what a later stylesheet overrides is not counted). Used by `node tools/shots.mjs --visual --audit`, which
// runs it on every screen in every theme, and by e2e/ui-stress.mjs.
//
// Rules (see web/css/tokens.css): type 12/13/14/16/20/28 px, weight 400 (500 for headings); spacing on a 4px grid
// (1px and 2px are allowed for a hairline or a bar); accent colour only for the focus ring, the current row's bar, the
// send button and progress; text at least 4.5:1 against its background; no clipped or overlapping text, nothing
// outside the window.

/**
 * Runs in the page. Returns the findings as [{ k, s, v, n, t }]: kind, where (a short selector path), what, how many
 * elements, and a sample of its text. Kinds: size, weight, space, accent, contrast, clip, overlap, outside, scroll.
 * The function is sent to the page as source, so it uses nothing from outside itself.
 */
export function auditPage() {
  const SIZES = [12, 13, 14, 16, 20, 28];
  const HEAD = 'h1, h2, h3, h4, h5, h6, [role=heading], [data-heading], strong, b, th, legend';
  const HEAD_CLASS = /(^|-)(h|hd|head|heading|title|t|name)$/;
  const isHead = (el) => {
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) if (e.matches(HEAD) || [...e.classList].some((c) => HEAD_CLASS.test(c))) return true;
    return false;
  };
  const SKIP = '.term-host, .xterm, svg, canvas, iframe, script, style, .tp-win, [data-audit-skip]';
  const found = new Map();
  const add = (k, el, v, t = '') => {
    const s = path(el);
    const key = `${k}|${s}|${v}`;
    const f = found.get(key);
    if (f) f.n++;
    else found.set(key, { k, s, v, n: 1, t: String(t).replace(/\s+/g, ' ').trim().slice(0, 40) });
  };
  function path(el) {
    const parts = [];
    for (let e = el, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) {
      const cls = [...e.classList].filter((c) => !/^(on|cur|open|active|sel|focus|hover)$/.test(c)).slice(0, 2).map((c) => `.${c}`).join('');
      parts.push(`${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls}`);
    }
    return parts.join(' < ');
  }
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top, under) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  /** The colour behind an element, or null when a gradient or an image is behind it. */
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null;
      const bg = rgba(cs.backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 0.999) break;
    }
    let base = [0, 0, 0, 1];
    if (!layers.length || layers[layers.length - 1][3] < 0.999) base = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (base[3] < 0.999) base = document.documentElement.dataset.theme === 'light' ? [255, 255, 255, 1] : [0, 0, 0, 1];
    return layers.reduceRight((under, l) => over(l, under), base);
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  const probe = (name) => {
    const e = document.createElement('i');
    e.style.cssText = `position:fixed;left:-9px;top:-9px;width:1px;height:1px;color:var(${name})`;
    document.body.append(e);
    const c = rgba(getComputedStyle(e).color);
    e.remove();
    return c;
  };
  const accents = ['--accent', '--accent-solid'].map(probe).filter((c) => c[3] > 0.5);
  const ink = document.documentElement.dataset.theme === 'graphite'; // its accent is ink: no hue to tell from text
  const sameRgb = (c) => c[3] > 0.05 && accents.some((a) => Math.abs(a[0] - c[0]) < 3 && Math.abs(a[1] - c[1]) < 3 && Math.abs(a[2] - c[2]) < 3);
  // Where the accent belongs: the send button and a screen's one primary action, progress, the current row's bar,
  // today's bar, the current timeline dot.
  const ACCENT_OK = '.send, .send *, .btn.primary, .btn.primary *, [role=progressbar], [role=progressbar] *, progress, .ring-arc, .ctx-bar i, .wk-track i.today, .turn-mark, .br-load, .spin, .dgrid, .dgrid *, .dot.run';
  // pseudo-elements: the current row's bar, the model rail's current mark and the caret of a reply being typed
  const PSEUDO_OK = '.s-btn, .side-link, .side-new, .mp-pv, .msg.live .md *';
  const onGrid = (v) => {
    v = Math.abs(v);
    return v < 0.01 || Math.abs(v - 1) < 0.05 || Math.abs(v - 2) < 0.05 || Math.abs(v % 4) < 0.05 || Math.abs((v % 4) - 4) < 0.05;
  };
  const all = [...document.querySelectorAll('body *')];
  const texty = [];
  for (const el of all) {
    if (el.closest(SKIP)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (el.closest('[hidden], [aria-hidden=true]') && !el.closest('dialog, .modal')) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    const field = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea, select');
    if (ownText || field) {
      const px = parseFloat(cs.fontSize);
      if (px > 0 && !SIZES.includes(Math.round(px * 100) / 100)) add('size', el, `${Math.round(px * 100) / 100}px`, el.textContent);
      const fw = parseInt(cs.fontWeight, 10);
      if (fw !== 400 && !(fw === 500 && isHead(el))) add('weight', el, String(fw), el.textContent);
      texty.push({ el, cs, r });
    }
    // spacing on the 4px grid (1px and 2px allowed)
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const raw = cs[p];
      if (raw === 'normal' || raw === '0px') continue;
      const v = parseFloat(raw);
      if (!onGrid(v)) add('space', el, `${p.replace(/([A-Z])/g, '-$1').toLowerCase()} ${Math.round(v * 100) / 100}px`, el.textContent);
    }
    for (const p of ['marginTop', 'marginRight', 'marginBottom', 'marginLeft']) {
      const v = parseFloat(cs[p]);
      if (!v || onGrid(v)) continue;
      // auto margins resolve to whatever is left over: not a choice
      const prop = p.replace(/([A-Z])/g, '-$1').toLowerCase();
      const typed = el.computedStyleMap?.().get(prop);
      if (typed && typed.value === 'auto') continue;
      add('space', el, `${p.replace(/([A-Z])/g, '-$1').toLowerCase()} ${Math.round(v * 100) / 100}px`, el.textContent);
    }
    // accent colour in places that are not the focus ring, the current row, send or progress
    if (!ink && !el.matches(ACCENT_OK) && !el.closest(ACCENT_OK)) {
      for (const [p, label] of [['color', 'text'], ['backgroundColor', 'fill'], ['borderTopColor', 'border'], ['borderBottomColor', 'border'], ['borderLeftColor', 'border'], ['borderRightColor', 'border'], ['outlineColor', 'outline']]) {
        if ((p.startsWith('border') && cs[p.replace('Color', 'Style')] === 'none') || (p === 'outlineColor' && cs.outlineStyle === 'none')) continue;
        // text colour is inherited: only the element that sets it counts
        if (p === 'color' && el.parentElement && getComputedStyle(el.parentElement).color === cs.color) continue;
        if ((label === 'border' || label === 'outline') && el.matches(':focus-within, :focus-visible')) continue; // the focus ring
        if (sameRgb(rgba(cs[p]))) add('accent', el, label, el.textContent);
      }
      for (const pseudo of ['::before', '::after']) {
        if (el.matches(PSEUDO_OK) || el.closest('.msg.live')) continue;
        const ps = getComputedStyle(el, pseudo);
        if (ps.content === 'none' || ps.content === 'normal' || ps.display === 'none') continue;
        if (sameRgb(rgba(ps.backgroundColor))) add('accent', el, `${pseudo} fill`, el.textContent);
      }
    }
    // text that is clipped, not cut with an ellipsis on purpose
    if (ownText && !/ellipsis/.test(cs.textOverflow) && !(cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) {
      if (/(hidden|clip)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) add('clip', el, `x ${el.scrollWidth}>${el.clientWidth}`, el.textContent);
      else if (/(hidden|clip)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && cs.whiteSpace !== 'nowrap') add('clip', el, `y ${el.scrollHeight}>${el.clientHeight}`, el.textContent);
    }
    // outside the window (not in something that scrolls or is positioned off on purpose)
    if (cs.position !== 'fixed' && (r.right > innerWidth + 1 || r.left < -1) && !el.closest('[data-offscreen]')) {
      let scrolls = false;
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(e).overflowX)) { scrolls = true; break; }
      if (!scrolls && !el.matches('.sr-only, .skip')) add('outside', el, `${Math.round(r.left)}..${Math.round(r.right)} of ${innerWidth}`, el.textContent);
    }
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) add('scroll', document.documentElement, `x ${document.documentElement.scrollWidth}>${innerWidth}`);
  // contrast of every text element against what is behind it
  for (const { el, cs } of texty) {
    if (el.matches(':disabled, [aria-disabled=true]') || el.closest('[aria-disabled=true]')) continue;
    const bg = backdrop(el);
    if (!bg) continue;
    let fg = rgba(cs.color);
    fg[3] *= opacityOf(el);
    if (fg[3] < 0.05) continue;
    const c = ratio(over(fg, bg), bg);
    if (c < 4.5) add('contrast', el, `${c.toFixed(2)}:1`, el.value || el.textContent);
    if (el.matches('input, textarea') && el.placeholder && !el.value) {
      const pc = rgba(getComputedStyle(el, '::placeholder').color);
      pc[3] *= opacityOf(el);
      const pr = ratio(over(pc, bg), bg);
      if (pr < 4.5) add('contrast', el, `placeholder ${pr.toFixed(2)}:1`, el.placeholder);
    }
  }
  // what is really on screen at a place: the element, or something inside it or around it, is the top thing there
  const shows = (el, l, r, t, b) => {
    const y = (t + b) / 2;
    return [l + 2, (l + r) / 2, r - 2].some((x) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      return !!top && (top === el || el.contains(top) || top.contains(el));
    });
  };
  // text that overlaps other text
  const boxes = [];
  for (const { el } of texty) {
    if (el.matches('input, textarea, select')) continue;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      if (opacityOf(el) < 0.05) continue;
      // text that runs out of a box that clips it (an ellipsis) is only shown as far as the box
      let clip = null;
      for (let e = el; e && e !== document.body; e = e.parentElement) if (/(hidden|clip|auto|scroll)/.test(getComputedStyle(e).overflowX)) { clip = e.getBoundingClientRect(); break; }
      for (const q of rg.getClientRects()) {
        const [l, r2] = clip ? [Math.max(q.left, clip.left), Math.min(q.right, clip.right)] : [q.left, q.right];
        if (r2 - l > 2 && q.height > 4 && shows(el, l, r2, q.top, q.bottom)) boxes.push({ el, l, r: r2, t: q.top, b: q.bottom });
      }
    }
  }
  boxes.sort((a, b) => a.l - b.l);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j].l < boxes[i].r - 2; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      if (a.el === b.el) continue;
      const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
      const hh = Math.min(a.b, b.b) - Math.max(a.t, b.t);
      if (w > 2 && hh > 3 && w * hh > 16) add('overlap', a.el, `text with ${path(b.el)}`, a.el.textContent);
    }
  }
  // controls that overlap controls
  const layered = (e) => { for (let x = e, i = 0; x && i < 4; x = x.parentElement, i++) if (/(sticky|fixed)/.test(getComputedStyle(x).position)) return true; return false; };
  const ctl = all.filter((e) => e.matches('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem], [role=option]') && !e.closest(SKIP) && !e.closest('[hidden], [aria-hidden=true]')).map((e) => ({ e, r: e.getBoundingClientRect(), cs: getComputedStyle(e) })).filter((x) => x.r.width > 3 && x.r.height > 3 && x.cs.visibility !== 'hidden' && x.cs.display !== 'none' && opacityOf(x.e) >= 0.05 && x.cs.pointerEvents !== 'none' && shows(x.e, x.r.left, x.r.right, x.r.top, x.r.bottom));
  for (let i = 0; i < ctl.length; i++) {
    for (let j = i + 1; j < ctl.length; j++) {
      const [a, b] = [ctl[i], ctl[j]];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      if (a.e.parentElement === b.e.parentElement && (a.cs.position === 'absolute' || b.cs.position === 'absolute')) continue; // laid over its sibling on purpose
      if (layered(a.e) || layered(b.e)) continue; // a sticky or fixed bar over what scrolls under it
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const hh = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 3 && hh > 3 && w * hh > 24) add('overlap', a.e, `control with ${path(b.e)}`, a.e.textContent || a.e.getAttribute('aria-label'));
    }
  }
  // a control pressed against the edge of the card it sits in (a card: a rounded box with a border or a fill of its own)
  const boxed = (e) => {
    const cs = getComputedStyle(e);
    if (parseFloat(cs.borderTopLeftRadius) < 6) return false;
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat(cs[`border${k}Width`]) >= 1 && rgba(cs[`border${k}Color`])[3] > 0.05);
    return border || /inset/.test(cs.boxShadow);
  };
  const drawn = (cs) => rgba(cs.backgroundColor)[3] > 0.05 || ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat(cs[`border${k}Width`]) >= 1 && rgba(cs[`border${k}Color`])[3] > 0.05);
  for (const { e, r, cs } of ctl) {
    if (e.closest('.seg, .switch, .menu, .pop-panel, .tabs, [role=tablist], .composer, .c-row, .modal-h') || e.matches('[role=tab], [role=menuitem], [role=option]')) continue;
    if (e.matches('input, select, textarea') && !drawn(cs)) continue; // a field without a box of its own (a search bar's input)
    for (let p = e.parentElement, i = 0; p && p !== document.body && i < 5; p = p.parentElement, i++) {
      if (!boxed(p)) continue;
      const pr = p.getBoundingClientRect();
      if (pr.height < r.height + 12 || pr.width < r.width + 12) break; // a frame drawn tight around this one control
      const pcs = getComputedStyle(p);
      const gaps = { top: r.top - pr.top - parseFloat(pcs.borderTopWidth), bottom: pr.bottom - r.bottom - parseFloat(pcs.borderBottomWidth), left: r.left - pr.left - parseFloat(pcs.borderLeftWidth), right: pr.right - r.right - parseFloat(pcs.borderRightWidth) };
      const tight = Object.entries(gaps).filter(([, g]) => g >= -1 && g < 4).map(([k]) => k);
      if (tight.length) add('edge', e, `${tight.join(' ')} of ${path(p)}`, e.textContent || e.getAttribute('aria-label') || e.placeholder);
      break;
    }
  }
  // fields and buttons side by side in one row: one height
  const rows = new Set(ctl.filter((x) => x.e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, .btn')).map((x) => x.e.parentElement));
  for (const row of rows) {
    const rcs = getComputedStyle(row);
    if (!/flex/.test(rcs.display) || /column/.test(rcs.flexDirection)) continue;
    const kids = ctl.filter((x) => x.e.parentElement === row && x.e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]), select, .btn'));
    if (kids.length < 2 || !kids.some((x) => x.e.matches('input, select'))) continue;
    const hs = kids.map((x) => Math.round(x.r.height));
    if (Math.max(...hs) - Math.min(...hs) > 1) add('height', row, hs.join('/'), kids.map((x) => x.e.textContent || x.e.placeholder || '').join(' | '));
  }
  return [...found.values()];
}

/** Runs in the page before a Tab walk: remembers how every control looks without focus. Returns how many there are. */
export function focusPrepare() {
  const style = (e) => {
    const cs = getComputedStyle(e);
    const bits = ['::before', '::after'].map((p) => { const ps = getComputedStyle(e, p); return `${ps.opacity}/${ps.backgroundColor}`; });
    return [cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.backgroundColor, cs.color, cs.textDecorationLine, ...bits].join('|');
  };
  const wrap = (e) => e.closest('label, .field, .composer, .set-search, .cz-search, .c-box, .seg, .switch');
  const list = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.disabled && !e.closest('[hidden], [aria-hidden=true], .term-host');
  });
  const snap = new Map();
  for (const e of list) snap.set(e, { own: style(e), wrap: wrap(e) ? style(wrap(e)) : null });
  window.__focusSnap = { snap, style, wrap };
  document.activeElement?.blur?.();
  return list.length;
}

/** Runs in the page after each Tab: what has focus, whether the browser calls it keyboard focus, and whether it shows. */
export function focusProbe() {
  const { snap, style, wrap } = window.__focusSnap;
  const e = document.activeElement;
  if (!e || e === document.body) return null;
  const was = snap.get(e);
  const label = (e.getAttribute('aria-label') || e.textContent || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const cls = [...e.classList].slice(0, 2).map((c) => `.${c}`).join('');
  const sel = `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls}`;
  const w = wrap(e);
  const changed = !was || style(e) !== was.own || (!!was.wrap && !!w && style(w) !== was.wrap);
  return { sel, label, fv: e.matches(':focus-visible'), changed, key: `${sel}|${label}` };
}

/** The page-side expression for page.eval: runs `fn` and returns its findings. */
export const inPage = (fn) => `return (${fn.toString()})();`;

/** Groups findings from many screens: one row per (kind, where, what), with the screens it was seen on. */
export function summarize(perScreen) {
  const rows = new Map();
  for (const [screen, list] of Object.entries(perScreen)) {
    for (const f of list) {
      const key = `${f.k}|${f.s}|${f.v}`;
      const r = rows.get(key) || { k: f.k, s: f.s, v: f.v, n: 0, screens: new Set(), t: f.t };
      r.n += f.n;
      r.screens.add(screen);
      rows.set(key, r);
    }
  }
  return [...rows.values()].sort((a, b) => a.k.localeCompare(b.k) || b.screens.size - a.screens.size || a.s.localeCompare(b.s));
}
