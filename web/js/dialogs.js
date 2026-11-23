// Modals, menus and pickers: modal, confirm, prompt, folder picker, model picker, agent requests, palette.
import { h, $, icon, iconBtn, replace, toast, fmtTokens, skeleton, kbd, leave, errorState, loadingState, onEnter } from './dom.js';
import { api } from './api.js';
import { replyUi, S, savePrefs } from './store.js';
import { brandMark, brandTile, modelMark } from './brands.js';
import { fuzzy, marked } from './composer.js';

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],a[href]';
function topModal(root) {
  for (let el = root.lastElementChild; el; el = el.previousElementSibling) {
    if (!el.classList.contains('closing')) return el;
  }
  return null;
}

function syncModalFocus(root) {
  const top = topModal(root);
  for (const layer of root.children) layer.inert = layer !== top;
  // Settings fills the window under the menu row, so the menu row (menus, the update, the window) stays usable.
  const full = !!top?.querySelector('.settings-card');
  for (const [id, off] of [['app', !!top], ['topbar', !!top], ['chrome', !!top && !full]]) {
    const page = document.getElementById(id);
    if (page) page.inert = off;
  }
}

export function modal({ title, body, actions = [], size = '', cls = '', onClose, initialFocus, returnFocus }) {
  const root = $('#modal-root');
  // A dialog replaces any open menu (a double-click on a name opens its menu with the first click, then renames).
  const openMenu = document.querySelector('.menu:not(.leaving)');
  const prev = openMenu?.contains(document.activeElement) ? openMenu._anchor : document.activeElement;
  openMenu?._close?.();
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => e.target === scrim && close() });
  const bodyEl = h('div', { class: 'modal-b' }, body);
  const foot = actions.length ? h('div', { class: 'modal-f' }, actions) : null;
  const box = h('div', { class: `modal${size ? ' ' + size : ''}${cls ? ' ' + cls : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }, h('div', { class: 'modal-h' }, h('h2', null, title), iconBtn('x', 'Close (Esc)', () => close())), bodyEl, foot);
  scrim.append(box);
  const isTop = () => topModal(root) === scrim;
  const onKey = (e) => {
    if (!isTop() || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      if (document.querySelector('.menu:not(.leaving)')) return; // Esc closes the open menu first
      if (e.target?.matches?.('input[type=search]') && e.target.value) return; // …and clears a search box first
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll(FOCUSABLE)].filter((x) => x.tabIndex >= 0 && x.getClientRects().length && !x.closest('[inert]'));
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) (e.preventDefault(), first.focus());
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.append(scrim);
  syncModalFocus(root);
  let closed = false;
  function close(val) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.add('closing');
    syncModalFocus(root);
    setTimeout(() => scrim.remove(), 180);
    onClose?.(val);
    try {
      let target = returnFocus?.() || prev;
      // The opener was redrawn while the dialog was open (Home rebuilds its composer row as models load): return to
      // the button that took its place, found by its classes and tooltip, instead of losing focus to the page.
      if (target && !target.isConnected && target.classList?.length) target = document.querySelector([...target.classList].map((c) => '.' + CSS.escape(c)).join('') + (target.title ? `[title="${CSS.escape(target.title)}"]` : ''));
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    } catch {}
  }
  setTimeout(() => {
    if (closed || !isTop()) return;
    const target = initialFocus || box.querySelector('input:not([type=checkbox]):not([type=range]),textarea,select,button.primary') || box;
    target.focus?.({ preventScroll: true });
  }, 0);
  return { close, el: box, body: bodyEl };
}

/**
 * A button. When `onclick` returns a promise, the button shows that it is working and ignores further clicks until the
 * promise settles, so a slow action (apply, approve, discard) can never be started twice.
 */
export const btn = (label, onclick, cls = '') => {
  const b = h('button', { class: `btn ${cls}`.trim(), type: 'button' }, label);
  b.addEventListener('click', (e) => {
    if (b.classList.contains('busy')) return;
    const r = onclick?.(e);
    if (!r || typeof r.then !== 'function') return;
    b.classList.add('busy');
    b.setAttribute('aria-busy', 'true');
    const done = () => {
      b.classList.remove('busy');
      b.removeAttribute('aria-busy');
    };
    r.then(done, done);
  });
  return b;
};

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({ title, size: 'sm', body: h('p', { class: 'prewrap' }, message), onClose: (v) => resolve(!!v), actions: [btn('Cancel', () => m.close(false)), btn(ok, () => m.close(true), danger ? 'danger-solid primary' : 'primary')] });
  });
}

/**
 * Ask for one line of text. Resolves with the trimmed text, or null when cancelled. A blank answer is not accepted:
 * the field says so and the dialog stays open (unless `allowEmpty`).
 */
export function promptDialog(title, label, value = '', { ok = 'Save', allowEmpty = false, maxLength = 200 } = {}) {
  return new Promise((resolve) => {
    const err = h('small', { class: 'field-err', role: 'alert', hidden: true }, `${label} cannot be empty`);
    const inp = h('input', { type: 'text', value, maxlength: String(maxLength), spellcheck: 'false', 'aria-label': label, oninput: () => ((err.hidden = true), inp.removeAttribute('aria-invalid')) });
    const go = () => {
      const v = inp.value.trim();
      if (!v && !allowEmpty) {
        err.hidden = false;
        inp.setAttribute('aria-invalid', 'true');
        inp.focus();
        return;
      }
      m.close(v);
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      // Handled here, once: without preventDefault the same Enter would also press whatever button gets the focus back
      // when the dialog closes (the conversation row or the menu that opened it).
      e.preventDefault();
      e.stopPropagation();
      go();
    });
    const m = modal({ title, size: 'sm', initialFocus: inp, body: h('label', { class: 'field' }, h('span', null, label), inp, err), onClose: (v) => resolve(typeof v === 'string' ? v : null), actions: [btn('Cancel', () => m.close(null)), btn(ok, go, 'primary')] });
    setTimeout(() => inp.isConnected && inp.select(), 0);
  });
}

/**
 * A small menu under (or above) `anchor`. Items: { label, hint, on, run, danger } or '-' for a separator.
 * Arrow keys move, Enter picks, Esc or an outside click closes and focus returns to the anchor.
 */
export function popMenu(anchor, items, { align = 'start', minWidth = 200 } = {}) {
  document.querySelector('.menu:not(.leaving)')?._close?.();
  if (!anchor.isConnected || !anchor.getClientRects().length) return () => {};
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu', role: 'menu' },
    // An item: { label, icon?, hint?, desc? (a second line), on? (a check in front), sel? (a check at the end, as a radio), danger? }.
    items.map((it) => (it === '-' ? h('div', { class: 'menu-sep', role: 'separator' }) : it.header ? h('div', { class: 'menu-h' }, it.header) : h('button', { class: 'menu-it' + (it.danger ? ' danger' : '') + (it.desc ? ' two' : ''), type: 'button', role: it.sel != null ? 'menuitemradio' : it.on != null ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.sel != null ? String(!!it.sel) : it.on != null ? String(!!it.on) : null, onclick: () => pick(it) }, it.on != null ? h('span', { class: 'menu-check' }, it.on ? icon('check', 14) : null) : it.icon ? icon(it.icon, 14, 'menu-ic') : null, h('span', { class: 'menu-l' }, it.label, it.desc ? h('small', { class: 'menu-d' }, it.desc) : null), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null, it.sel ? icon('check', 14, 'menu-sel') : null))));
  m.style.minWidth = Math.max(minWidth, r.width) + 'px';
  document.body.append(m);
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  const left = align === 'end' ? r.right - mw : r.left;
  m.style.left = Math.max(8, Math.min(left, innerWidth - mw - 8)) + 'px';
  const below = r.bottom + 4 + mh <= innerHeight - 8 || r.top - 4 - mh < 8;
  m.style.top = (below ? r.bottom + 4 : r.top - 4 - mh) + 'px';
  m.classList.add(below ? 'down' : 'up');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    leave(m);
    document.removeEventListener('mousedown', off, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('blur', close);
    removeEventListener('resize', close);
  };
  m._close = close;
  m._anchor = anchor;
  const pick = (it) => {
    close();
    anchor.focus?.({ preventScroll: true });
    it.run();
  };
  const off = (e) => !m.contains(e.target) && !anchor.contains(e.target) && close();
  const onKey = (e) => {
    const btns = [...m.querySelectorAll('.menu-it')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus?.({ preventScroll: true });
    } else if (e.key === 'ArrowDown') (e.preventDefault(), btns[(i + 1) % btns.length]?.focus());
    else if (e.key === 'ArrowUp') (e.preventDefault(), btns[(i - 1 + btns.length) % btns.length]?.focus());
    else if (e.key === 'Home') (e.preventDefault(), btns[0]?.focus());
    else if (e.key === 'End') (e.preventDefault(), btns[btns.length - 1]?.focus());
    else if (e.key === 'Tab') close();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', onKey, true);
    addEventListener('blur', close);
    addEventListener('resize', close);
  }, 0);
  (m.querySelector('.menu-it[aria-checked="true"]') || m.querySelector('.menu-it'))?.focus({ preventScroll: true });
  return close;
}

export function folderPicker(start = '') {
  return new Promise((resolve) => {
    let cur = start;
    const pathIn = h('input', { type: 'text', class: 'grow mono', placeholder: 'Type a path and press Enter', 'aria-label': 'Folder path', spellcheck: 'false' });
    const list = h('div', { class: 'list fp-list', role: 'listbox', 'aria-label': 'Folders' });
    const item = (ic, label, onclick) => h('button', { class: 'list-it', type: 'button', onclick }, icon(ic, 15), h('span', { class: 'grow ell' }, label));
    const load = async (p) => {
      replace(list, skeleton(7, 'pad'));
      try {
        const { listing } = await api.get(`/api/fs/list?path=${encodeURIComponent(p)}&dirs=1`);
        cur = listing.path;
        pathIn.value = cur;
        replace(
          list,
          listing.parent != null && cur ? item('chevron-left', 'Up one level', () => load(listing.parent)) : null,
          listing.entries.map((e) => item('folder', e.name, () => load(e.path))),
          !listing.entries.length ? h('div', { class: 'empty' }, 'No sub-folders') : null,
        );
      } catch (e) {
        replace(list, errorState(e.message, { title: 'Couldn’t open this folder.', retry: () => load(p) }));
      }
    };
    onEnter(pathIn, () => load(pathIn.value.trim()));
    const m = modal({
      title: 'Choose a project folder',
      body: h('div', { class: 'stack' }, h('div', { class: 'row' }, pathIn, btn('Drives', () => load(''))), list),
      onClose: (v) => resolve(v || null),
      actions: [btn('Cancel', () => m.close(null)), btn('Use this folder', () => cur && m.close(cur), 'primary')],
    });
    load(start);
  });
}

/** A model's details for its tooltip in the picker: id, context window and thinking levels. */
function modelTip(x) {
  const th = x.thinking;
  const levels = th?.efforts?.length ? `Thinking: ${[...(th.canOff === false ? [] : ['off']), ...th.efforts].join(', ')}${th.canOff === false ? ' (always thinks)' : ''}` : 'No thinking levels';
  return [x.id, x.contextWindow ? `Context: ${fmtTokens(x.contextWindow)} tokens` : '', levels].filter(Boolean).join('\n');
}

let pickerId = 0;
const keyOf = (x) => (x ? `${x.provider}/${x.id}` : '');
const THINK_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
export const thinkingName = (l) => THINK_NAMES[l] || String(l || '').charAt(0).toUpperCase() + String(l || '').slice(1);
/** The thinking levels a model offers, in order ('off' first when it can stop thinking). */
export const thinkingLevels = (x) => (x?.thinking?.efforts?.length ? [...(x.thinking.canOff === false ? [] : ['off']), ...x.thinking.efforts] : []);

/**
 * A small panel anchored to `anchor` (above it when there is no room below). Esc, an outside click or a resize close
 * it and focus goes back to the anchor. Returns { el, close }.
 */
export function popover(anchor, content, { align = 'start', cls = '', label = '' } = {}) {
  document.querySelector('.menu:not(.leaving)')?._close?.();
  const el = h('div', { class: `menu pop-panel${cls ? ' ' + cls : ''}`, role: 'dialog', 'aria-label': label || null }, content);
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(align === 'end' ? r.right - w : r.left, innerWidth - w - 8)) + 'px';
    const below = r.bottom + 6 + ht <= innerHeight - 8 || r.top - 6 - ht < 8;
    el.style.top = (below ? r.bottom + 6 : r.top - 6 - ht) + 'px';
    el.classList.toggle('down', below);
    el.classList.toggle('up', !below);
  };
  place();
  let closed = false;
  const close = (refocus = true) => {
    if (closed) return;
    closed = true;
    leave(el);
    document.removeEventListener('mousedown', off, true);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', close);
    if (refocus) anchor.focus?.({ preventScroll: true });
  };
  const off = (e) => !el.contains(e.target) && !anchor.contains(e.target) && close(false);
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  el._close = () => close(false);
  el._anchor = anchor;
  el._place = place;
  setTimeout(() => {
    document.addEventListener('mousedown', off, true);
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', close);
  }, 0);
  return { el, close };
}

/**
 * A menu whose rows open a submenu to the side, as in a desktop context menu: the pointer, → or Enter opens it, ←
 * goes back, Esc closes everything. An item: { icon, label, hint, count (number or element), dot ('ok' | 'bad' |
 * 'warn'), off, why, sub: () => items (or a promise of them), run }, '-' for a line, { header } for a title.
 * `head` (an element) goes above the rows.
 */
export function cascade(anchor, items, { head = null, cls = '', label = '', align = 'start' } = {}) {
  let sub = null;
  let subFor = null;
  let leaveTimer = 0;
  const closeSub = () => {
    clearTimeout(leaveTimer);
    sub?.remove();
    sub = null;
    subFor?.classList.remove('open');
    subFor?.setAttribute('aria-expanded', 'false');
    subFor = null;
  };
  const pick = (it) => {
    if (it.off) return;
    pop.close(false);
    it.run?.();
  };
  const rowOf = (it, inSub) => {
    if (it === '-') return h('div', { class: 'xm-sep', role: 'separator' });
    if (it.header) return h('div', { class: 'xm-h' }, it.header);
    const count = it.count == null || it.count === '' ? null : it.count instanceof Node ? it.count : h('span', { class: 'xm-n num' }, String(it.count));
    const b = h('button', { class: 'xm-it' + (it.off ? ' off' : '') + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', title: it.off ? it.why || null : it.title || null, 'aria-disabled': it.off ? 'true' : null, 'aria-haspopup': it.sub ? 'menu' : null, 'aria-expanded': it.sub ? 'false' : null },
      it.icon ? icon(it.icon, 14, 'xm-ic') : null,
      it.dot ? h('span', { class: `xm-dot ${it.dot}`, 'aria-hidden': 'true' }) : null,
      h('span', { class: 'xm-l ell' }, it.label),
      count,
      it.hint ? h('span', { class: 'xm-hint' }, it.hint) : null,
      it.sub ? icon('chevron-right', 12, 'xm-more') : null);
    if (it.sub && !inSub) {
      b.addEventListener('click', () => openSub(it, b, true));
      b.addEventListener('pointerenter', () => (clearTimeout(leaveTimer), subFor !== b && openSub(it, b, false)));
    } else {
      b.addEventListener('click', () => pick(it));
      // Moving onto a plain row closes an open submenu, a moment later (so a diagonal path to it does not).
      if (!inSub) b.addEventListener('pointerenter', () => sub && (clearTimeout(leaveTimer), (leaveTimer = setTimeout(closeSub, 160))));
    }
    return b;
  };
  const openSub = async (it, b, focus) => {
    if (it.off) return;
    if (subFor === b) return focus && sub?.querySelector('.xm-it')?.focus();
    closeSub();
    subFor = b;
    b.classList.add('open');
    b.setAttribute('aria-expanded', 'true');
    const el = h('div', { class: 'xm-sub', role: 'menu', 'aria-label': it.label }, h('div', { class: 'xm-wait' }, h('span', { class: 'xm-spin', 'aria-hidden': 'true' }), 'Loading…'));
    el.addEventListener('pointerenter', () => clearTimeout(leaveTimer));
    sub = el;
    pop.el.append(el);
    const place = () => {
      const r = b.getBoundingClientRect();
      const p = pop.el.getBoundingClientRect();
      const w = el.offsetWidth;
      const right = p.right + 6 + w <= innerWidth - 8;
      el.style.left = `${right ? p.width + 6 : -w - 6}px`;
      el.classList.toggle('left', !right);
      const top = Math.max(8 - p.top, Math.min(r.top - p.top - 5, innerHeight - 8 - p.top - el.offsetHeight));
      el.style.top = `${top}px`;
    };
    place();
    let list;
    try {
      list = await (typeof it.sub === 'function' ? it.sub() : it.sub);
    } catch (e) {
      list = [{ label: e.message || 'Could not load this', off: true }];
    }
    if (sub !== el) return;
    el.replaceChildren(...(list?.length ? list : [{ label: 'Nothing here yet', off: true }]).filter(Boolean).map((x) => rowOf(x, true)));
    place();
    if (focus) el.querySelector('.xm-it:not(.off)')?.focus({ preventScroll: true });
  };
  const content = [head, ...items.filter(Boolean).map((it) => rowOf(it, false))].filter(Boolean);
  const pop = popover(anchor, h('div', { class: 'xm-rows', role: 'menu', 'aria-label': label || null }, content), { cls: `xm ${cls}`.trim(), label, align });
  const rowsOf = (box) => [...box.querySelectorAll(':scope > .xm-it, :scope > .xm-rows > .xm-it')].filter((x) => !x.classList.contains('off'));
  pop.el.addEventListener('keydown', (e) => {
    const inSub = !!document.activeElement?.closest('.xm-sub');
    const box = inSub ? sub : pop.el.querySelector('.xm-rows');
    const list = rowsOf(box);
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!inSub) closeSub();
      return list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
    if (e.key === 'Home' || e.key === 'End') return e.preventDefault(), list[e.key === 'Home' ? 0 : list.length - 1]?.focus();
    if (e.key === 'ArrowRight' && !inSub && document.activeElement?.getAttribute('aria-haspopup')) return e.preventDefault(), document.activeElement.click();
    if (e.key === 'ArrowLeft' && inSub) {
      e.preventDefault();
      const back = subFor;
      closeSub();
      return back?.focus();
    }
    if (e.key === 'Tab') pop.close(false);
  });
  rowsOf(pop.el.querySelector('.xm-rows'))[0]?.focus({ preventScroll: true });
  return pop;
}

/**
 * The model picker, a panel over the message box: providers as marks on the left (Starred and Recent first, agent
 * CLIs after), that provider's models in the middle, and the highlighted model's reasoning levels on the right. One
 * search covers every model. ↑ ↓ move, ← → change provider, Enter picks, Ctrl+1…9 picks a listed model.
 * `load()` returns { models, errors } or a list; `onPick(model, level?)` applies one (throw to keep the picker open);
 * `level` is the current thinking level (with `thinking: true` the reasoning column shows); `extra` is the label of a
 * "use the default" choice (Home), picked as null.
 */
export function modelPicker({ load, current, onPick, extra, loading = 'Loading models…', returnFocus, anchor, thinking = false, level = '' }) {
  const id = `models-${++pickerId}`;
  const rail = h('div', { class: 'mp-rail', role: 'tablist', 'aria-label': 'Providers', 'aria-orientation': 'vertical' });
  const list = h('div', { id, class: 'list mp-list', role: 'listbox', 'aria-label': 'Models' });
  const side = h('div', { class: 'mp-side', hidden: true });
  const q = h('input', { type: 'search', role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': id, 'aria-expanded': 'false', placeholder: 'Search models…', 'aria-label': 'Search models', spellcheck: 'false', autocomplete: 'off' });
  const feedback = h('span', { class: 'mp-results', role: 'status' });
  const foot = h('div', { class: 'mp-footer' }, feedback);
  const body = h('div', { class: 'mp-layout' }, rail, h('div', { class: 'mp-main' }, h('label', { class: 'mp-search' }, icon('search', 14), q), list), side, foot);
  const m = modal({ title: 'Choose a model', cls: 'model-picker' + (anchor ? ' anchored' : ''), body, initialFocus: q, returnFocus });
  const scrim = m.el.parentElement;
  m.el.classList.toggle('with-side', !!thinking);
  if (anchor) {
    scrim.classList.add('pop');
    // Above the chip when there is room (the message box sits at the bottom), else below; kept on screen as it grows.
    const place = () => {
      if (!anchor.isConnected || !scrim.isConnected) return;
      const r = anchor.getBoundingClientRect();
      const above = r.top - 16;
      const below = innerHeight - r.bottom - 16;
      const up = above >= 300 || above >= below;
      m.el.style.maxHeight = Math.min(460, Math.max(160, up ? above : below)) + 'px';
      const w = m.el.offsetWidth;
      m.el.style.left = Math.max(8, Math.min(r.left - 8, innerWidth - w - 8)) + 'px';
      m.el.style.top = up ? '' : r.bottom + 8 + 'px';
      m.el.style.bottom = up ? innerHeight - r.top + 8 + 'px' : '';
      m.el.classList.toggle('up', up);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(m.el);
    addEventListener('resize', place);
    const gone = new MutationObserver(() => !scrim.isConnected && (removeEventListener('resize', place), ro.disconnect(), gone.disconnect()));
    gone.observe(scrim.parentElement, { childList: true });
  }
  let models = [];
  let errors = [];
  let groups = []; // [{ key, name, mark, models, kind: 'recent' | 'fav' | 'provider' | 'agent' }]
  let pv = '';
  let shown = [];
  let options = [];
  let sel = 0;
  let choosing = false;
  const names = () => new Map([...(S.engine?.providers || []), ...(S.engine?.agents || [])].map((p) => [p.id, p.name]));
  const prefList = (k) => (Array.isArray(S.ui?.[k]) ? S.ui[k] : []);
  const choose = async (x, lvl) => {
    if (choosing || !list.isConnected) return;
    choosing = true;
    list.setAttribute('aria-busy', 'true');
    try {
      await onPick(x, lvl);
      if (x) savePrefs({ modelRecent: [keyOf(x), ...prefList('modelRecent').filter((k) => k !== keyOf(x))].slice(0, 8) });
      m.close();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      choosing = false;
      list.removeAttribute('aria-busy');
    }
  };
  const star = (x) => {
    const k = keyOf(x);
    const fav = prefList('modelFav');
    savePrefs({ modelFav: fav.includes(k) ? fav.filter((f) => f !== k) : [k, ...fav].slice(0, 30) });
    build();
    draw();
  };
  const build = () => {
    const nm = names();
    const byKey = new Map(models.map((x) => [keyOf(x), x]));
    const pick = (keys) => keys.map((k) => byKey.get(k)).filter(Boolean);
    const recent = pick(prefList('modelRecent'));
    const fav = pick(prefList('modelFav'));
    const byProv = new Map();
    for (const x of models) (byProv.get(x.provider) || byProv.set(x.provider, []).get(x.provider)).push(x);
    groups = [
      ...(fav.length ? [{ key: ':fav', name: 'Starred', icon: 'star', models: fav, kind: 'fav' }] : []),
      ...(recent.length ? [{ key: ':recent', name: 'Recent', icon: 'clock', models: recent, kind: 'recent' }] : []),
      ...[...byProv].map(([p, arr]) => ({ key: p, name: nm.get(p) || p, mark: p, models: arr, kind: p.startsWith('agent-') ? 'agent' : 'provider' })).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'agent' ? 1 : -1)),
    ];
    if (!groups.some((g) => g.key === pv)) pv = (current && groups.find((g) => g.key === current.provider)?.key) || groups.find((g) => g.kind === 'fav' || g.kind === 'recent')?.key || groups[0]?.key || '';
  };
  const row = (x, withProvider, n) => {
    const isCur = !!current && keyOf(current) === keyOf(x);
    const faved = prefList('modelFav').includes(keyOf(x));
    const starBtn = h('span', { class: 'mp-star' + (faved ? ' on' : ''), role: 'button', tabindex: '-1', title: faved ? 'Unstar' : 'Star: keep it at the top', 'aria-label': faved ? `Unstar ${x.name || x.id}` : `Star ${x.name || x.id}`, onclick: (e) => (e.stopPropagation(), star(x)) }, icon('star', 13));
    return h('button', { class: 'list-it mp-it' + (isCur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(isCur), title: modelTip(x), onclick: () => choose(x), onmousemove: () => { if (shown[sel] !== x) ((sel = shown.indexOf(x)), mark()); } },
      modelMark(x.provider, x.id, 15, 'mp-pmark'),
      h('span', { class: 'mp-name ell' }, x.name || x.id, withProvider ? h('small', null, names().get(x.provider) || x.provider) : null),
      isCur ? icon('check', 14, 'mp-cur') : null,
      h('span', { class: 'grow' }),
      x.contextWindow ? h('span', { class: 'mp-ctx num' }, fmtTokens(x.contextWindow)) : null,
      starBtn,
      n <= 9 ? h('kbd', { class: 'mp-key' }, `Ctrl+${n}`) : null);
  };
  // Connect another provider or agent: the picker closes and Connect opens; the next picker lists the new models.
  const connectMore = () => {
    m.close();
    import('./connect.js').then((x) => x.openConnect());
  };
  // The reasoning column: the highlighted model's levels; a click picks that model at that level.
  let sideFor = null;
  const drawSide = () => {
    const x = shown[sel] || current;
    const levels = thinking ? thinkingLevels(x) : [];
    side.hidden = !thinking;
    if (!thinking || sideFor === x) return;
    sideFor = x;
    const isCur = !!current && x && keyOf(current) === keyOf(x);
    const at = isCur ? level || 'off' : x?.thinking?.default || (levels.includes('medium') ? 'medium' : levels[0]);
    replace(side, [
      h('div', { class: 'mp-side-h' }, h('span', null, 'Reasoning'), x ? h('small', { class: 'ell' }, x.name || x.id) : null),
      levels.length
        ? h('div', { class: 'mp-levels', role: 'group', 'aria-label': 'Reasoning' }, levels.map((l) => h('button', { class: 'mp-lvl' + (l === at ? ' on' : ''), type: 'button', 'aria-pressed': String(l === at), tabindex: '-1', onclick: () => choose(x, l) }, h('span', { class: 'grow' }, thinkingName(l)), l === at ? icon('check', 14) : null)))
        : h('p', { class: 'mp-side-none' }, x ? 'This model has no reasoning levels.' : ''),
    ]);
  };
  const draw = (initial = false) => {
    const f = q.value.toLowerCase().trim();
    const nm = names();
    const match = (x) => !f || `${nm.get(x.provider) || ''} ${x.provider} ${x.id} ${x.name || ''}`.toLowerCase().includes(f);
    replace(rail, [
      extra ? h('button', { class: 'mp-pv mp-default' + (!current ? ' cur' : ''), type: 'button', title: extra, 'aria-label': 'Default model', onclick: () => choose(null) }, icon('sparkle', 16)) : null,
      ...groups.flatMap((g, i) => {
        const n = f ? g.models.filter(match).length : g.models.length;
        const sep = i && g.kind !== groups[i - 1].kind && (g.kind === 'provider' || g.kind === 'agent') ? h('div', { class: 'mp-rail-sep', role: 'separator' }) : null;
        const b = h('button', { class: 'mp-pv' + (g.key === pv && !f ? ' on' : '') + (f && !n ? ' dim' : ''), type: 'button', role: 'tab', title: `${g.name} · ${n} ${n === 1 ? 'model' : 'models'}`, 'aria-label': g.name, 'aria-selected': String(g.key === pv && !f), onclick: () => ((pv = g.key), (q.value = ''), (sel = 0), draw(), q.focus()) },
          g.mark ? brandTile(g.mark, 24, 'mp-pmark') : icon(g.icon, 16));
        return [sep, b];
      }),
      h('div', { class: 'mp-rail-sep', role: 'separator' }),
      h('button', { class: 'mp-pv mp-add', type: 'button', title: 'Connect a provider or agent', 'aria-label': 'Connect a provider or agent', onclick: connectMore }, icon('plus', 16)),
    ].filter(Boolean));
    const kids = [];
    shown = [];
    options = [];
    const add = (x, withProvider) => {
      const b = row(x, withProvider, shown.length + 1);
      b.id = `${id}-${shown.length}`;
      b.tabIndex = -1;
      shown.push(x);
      options.push(b);
      kids.push(b);
    };
    if (f) {
      const seen = new Set();
      for (const g of groups) {
        if (g.kind === 'recent' || g.kind === 'fav') continue;
        const hit = g.models.filter(match);
        if (!hit.length) continue;
        kids.push(h('div', { class: 'list-h with-mark' }, brandMark(g.mark, 13), g.name));
        for (const x of hit) if (!seen.has(keyOf(x))) (seen.add(keyOf(x)), add(x, false));
      }
      if (!shown.length) kids.push(h('div', { class: 'empty' }, 'No model matches.'));
    } else {
      const g = groups.find((x) => x.key === pv);
      if (g) {
        kids.push(h('div', { class: 'list-h' }, g.name));
        for (const x of g.models) add(x, g.kind === 'recent' || g.kind === 'fav');
      } else kids.push(h('div', { class: 'empty mp-empty' }, h('p', null, 'No models yet. Connect a provider or an agent CLI to start.'), h('button', { class: 'btn primary sm', type: 'button', onclick: connectMore }, icon('plug', 14), 'Connect')));
    }
    if (errors.length) kids.push(h('div', { class: 'pad small warn-text', role: 'status' }, errors.join(' · ')));
    replace(list, kids);
    const total = f ? shown.length : models.length;
    feedback.textContent = f ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'}` : `${total} ${total === 1 ? 'model' : 'models'}${errors.length ? ` · ${errors.length} unavailable` : ''}`;
    q.setAttribute('aria-expanded', String(shown.length > 0));
    if (initial) sel = Math.max(0, shown.findIndex((x) => current && keyOf(x) === keyOf(current)));
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    marked = null;
    mark();
  };
  let marked = null;
  const mark = () => {
    const next = options[sel];
    if (next === marked && next?.isConnected) return;
    marked?.classList.remove('sel');
    marked = next;
    marked?.classList.add('sel');
    if (marked) q.setAttribute('aria-activedescendant', marked.id);
    else q.removeAttribute('aria-activedescendant');
    marked?.scrollIntoView({ block: 'nearest' });
    drawSide();
  };
  q.addEventListener('input', () => {
    sel = 0;
    draw();
  });
  // Ctrl+1…9 anywhere in the picker picks that row.
  m.el.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !/^[1-9]$/.test(e.key)) return;
    const x = shown[+e.key - 1];
    if (!x) return;
    e.preventDefault();
    choose(x);
  });
  q.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !q.value && groups.length) {
      e.preventDefault();
      const i = groups.findIndex((g) => g.key === pv);
      pv = groups[(i + (e.key === 'ArrowRight' ? 1 : -1) + groups.length) % groups.length].key;
      sel = 0;
      return draw();
    }
    if (!shown.length) return;
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(shown.length - 1, sel + 1)), mark());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)), mark());
    else if (e.key === 'Enter') (e.preventDefault(), choose(shown[sel]));
  });
  const fetchModels = () => {
    feedback.textContent = 'Loading model list';
    q.removeAttribute('aria-activedescendant');
    q.setAttribute('aria-expanded', 'false');
    replace(list, loadingState(loading, 6));
    return Promise.resolve()
      .then(load)
      .then((result) => {
        if (!list.isConnected) return;
        models = Array.isArray(result) ? result : result?.models || [];
        errors = Array.isArray(result?.errors) ? result.errors : [];
        build();
        draw(true);
      })
      .catch((e) => {
        if (!list.isConnected) return;
        feedback.textContent = 'Model list unavailable';
        replace(list, errorState(e.message, { title: 'Couldn’t load the models.', retry: fetchModels }));
      });
  };
  fetchModels();
  return m;
}

/** Approval answers are fixed values the engine understands; the buttons say them in the interface's words. */
const APPROVAL_LABEL = { 'Allow for this session': 'Allow in this conversation', 'Always allow this command': 'Always allow' };
export const approvalLabel = (o) => APPROVAL_LABEL[o] || o;

/** Tool approvals ("Allow once / Allow for this session / Deny") are shown inline above the composer, not as a modal. */
export const isApproval = (d) => d?.method === 'select' && Array.isArray(d.options) && d.options.every((o) => typeof o === 'string') && d.options.includes('Deny');

const openDlgs = new Map();
export function syncExtDialogs(tab) {
  const want = tab && !tab.dead ? tab.dialogs.find((d) => !isApproval(d)) || null : null;
  for (const [id, d] of openDlgs) if (d.tab !== tab || d.dlg !== want) {
    d.m.close('__sync');
    openDlgs.delete(id);
  }
  if (!want || openDlgs.has(want.id)) return;
  const rec = { tab, dlg: want };
  let answered = false;
  const answer = (payload) => {
    answered = true;
    replyUi(tab, want, payload);
    rec.m.close('__done');
  };
  let body;
  let actions;
  const title = want.title || 'The agent needs your input';
  if (want.method === 'select') {
    const opts = (want.options || []).map((o) => (typeof o === 'string' ? { label: o, value: o } : { label: o.label ?? String(o.value), value: o.value ?? o.label }));
    body = h('div', { class: 'stack' }, want.message ? h('p', { class: 'prewrap' }, want.message) : null, h('div', { class: 'list', role: 'listbox' }, opts.map((o, i) => h('button', { class: 'list-it', type: 'button', role: 'option', onclick: () => answer({ value: o.value }) }, h('span', { class: 'grow' }, o.label), i < 9 ? kbd(String(i + 1)) : null))));
    actions = [btn('Cancel', () => rec.m.close())];
  }
  rec.m = modal({
    title,
    body,
    actions,
    onClose: (v) => {
      openDlgs.delete(want.id);
      if (!answered && v !== '__sync') {
        answered = true;
        replyUi(tab, want, { cancelled: true });
      }
    },
  });
  if (want.method === 'select') {
    rec.m.el.addEventListener('keydown', (e) => {
      const n = +e.key;
      const items = rec.m.el.querySelectorAll('.list-it');
      if (n >= 1 && n <= items.length && !e.ctrlKey && !e.altKey && !e.metaKey) (e.preventDefault(), items[n - 1].click());
    });
  }
  openDlgs.set(want.id, rec);
}

/** A settings row: label (+ hint) on the left, control on the right. */
export const row = (label, control, hint) => h('div', { class: 'set-row' }, h('div', { class: 'set-k' }, h('div', { class: 'set-l' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null), h('div', { class: 'set-v' }, control));
export const toggle = (val, onchange, label) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', checked: val ? true : null, 'aria-label': label || null, onchange: (e) => onchange(e.target.checked) }), h('i'));


/**
 * Search everything (Ctrl+K): commands, conversations, projects and, with `opts.files`, files of the open project.
 * Items: { group, scope?, icon, label, hint?, text?, key?, run }. `scope` is one of SCOPES (default 'commands');
 * `text` is extra searchable text (a conversation's first message). `opts.files(query)` returns a promise of items
 * (scope 'files'); it is asked as you type, and stale answers are dropped. Tab / Shift+Tab change the scope.
 */
const SCOPES = [['all', 'All'], ['conversations', 'Conversations'], ['files', 'Files'], ['projects', 'Projects'], ['commands', 'Commands']];
export function palette(getItems, opts = {}) {
  const q = h('input', { type: 'search', class: 'pal-q', placeholder: 'Search conversations, files, projects and commands', 'aria-label': 'Search', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list' });
  const list = h('div', { class: 'list pal-list', role: 'listbox', id: 'pal-list' });
  const scopesEl = h('div', { class: 'pal-scopes', role: 'tablist', 'aria-label': 'Search in' });
  const foot = h('div', { class: 'pal-foot', 'aria-hidden': 'true' }, h('span', null, kbd('↑'), kbd('↓'), ' move'), h('span', null, kbd('Tab'), ' scope'), h('span', null, kbd('Enter'), ' open'), h('span', null, kbd('Esc'), ' close'));
  const m = modal({ title: 'Search', cls: 'palette', body: h('div', null, h('div', { class: 'pal-top' }, icon('search', 16), q), scopesEl, list, foot), initialFocus: q, onClose: () => { clearTimeout(fileTimer); fileSeq++; } });
  let scope = 'all';
  let files = [];
  let fileQ = '';
  let fileTimer = 0;
  let fileSeq = 0;
  let filesBusy = false;
  let filesErr = null; // why the last file search failed: shown with Retry, never as "No matches"
  const askFiles = (f) => {
    clearTimeout(fileTimer);
    const seq = ++fileSeq; // any answer already in flight belongs to an older query
    if (!opts.files || f.length < 2 || !(scope === 'all' || scope === 'files')) {
      files = [];
      fileQ = '';
      filesBusy = false;
      filesErr = null;
      return;
    }
    if (f === fileQ && !filesErr) {
      filesBusy = false;
      return;
    }
    filesBusy = true;
    fileTimer = setTimeout(async () => {
      let got = [];
      let err = null;
      try {
        got = await opts.files(f);
      } catch (e) {
        err = e;
      }
      if (seq !== fileSeq || !list.isConnected) return; // a newer query is on its way, or the palette closed
      files = got || [];
      fileQ = f;
      filesErr = err;
      filesBusy = false;
      draw();
    }, 140);
  };
  const drawScopes = () => replace(scopesEl, SCOPES.filter(([k]) => k !== 'files' || opts.files).map(([k, l]) => h('button', { type: 'button', role: 'tab', class: 'pal-scope' + (k === scope ? ' on' : ''), 'aria-selected': String(k === scope), tabindex: '-1', onclick: () => setScope(k) }, l)));
  const setScope = (k) => {
    scope = k;
    sel = 0;
    drawScopes();
    askFiles(q.value.trim());
    draw();
    q.focus();
  };
  let items = [];
  let sel = 0;
  const mark = () => {
    list.querySelectorAll('.list-it').forEach((x, k) => {
      x.classList.toggle('sel', k === sel);
      x.setAttribute('aria-selected', String(k === sel));
    });
    const cur = list.querySelectorAll('.list-it')[sel];
    cur?.scrollIntoView({ block: 'nearest' });
    if (cur) q.setAttribute('aria-activedescendant', cur.id);
  };
  const all = getItems().map((it) => ({ scope: 'commands', ...it }));
  const inScope = (it) => scope === 'all' || it.scope === scope;
  const draw = () => {
    const f = q.value.trim();
    const pool = [...all.filter(inScope), ...(inScope({ scope: 'files' }) ? files : [])];
    // Ranked fuzzy match on the label; a match in the hint, group or a conversation's first message ranks lower.
    // Results stay grouped (by best match within each group, groups in order of their best result).
    if (f) {
      const ranked = pool.map((it) => {
        const l = fuzzy(f, it.label);
        const o = l ? null : fuzzy(f, `${it.hint || ''} ${it.group}`) || (it.text && it.text.toLowerCase().includes(f.toLowerCase()) ? { score: 500 } : null);
        return l ? [l.score, it, l.hits] : o ? [o.score + 10000, it, []] : null;
      }).filter(Boolean).sort((a, b) => a[0] - b[0]).slice(0, 80);
      const order = [];
      for (const [, it] of ranked) if (!order.includes(it.group)) order.push(it.group);
      items = order.flatMap((g) => ranked.filter(([, it]) => it.group === g).slice(0, scope === 'all' ? 8 : 60).map(([, it, hits]) => ({ ...it, hits })));
    } else items = pool.filter((it) => !it.searchOnly).slice(0, 80); // settings show up once you type
    sel = Math.min(sel, Math.max(0, items.length - 1));
    let lastG = '';
    const fileErr = filesErr && inScope({ scope: 'files' }) && f.length >= 2 && !filesBusy
      ? errorState(filesErr.message, { title: 'File search failed.', cls: 'pal-err', retry: () => { fileQ = ''; askFiles(q.value.trim()); draw(); q.focus(); } })
      : null;
    const empty = scope === 'files' && f.length < 2 ? 'Type at least 2 characters to search files' : filesBusy && !items.length ? 'Searching files…' : f ? `No matches${scope === 'all' ? '' : ' in ' + SCOPES.find(([k]) => k === scope)[1].toLowerCase()}` : scope === 'files' ? 'Type at least 2 characters to search files' : 'Nothing here yet';
    replace(list, items.map((it, i) => [it.group !== lastG ? h('div', { class: 'list-h' }, (lastG = it.group)) : null, h('button', { class: 'list-it', id: `pal-${i}`, type: 'button', tabindex: '-1', role: 'option', onclick: () => run(it), onmousemove: () => sel !== i && ((sel = i), mark()) }, it.icon ? h('span', { class: 'pal-ico' }, icon(it.icon, 14)) : null, h('span', { class: 'grow ell' }, marked(it.label, it.hits)), it.hint ? h('span', { class: 'pal-hint ell' }, it.hint) : null, it.key ? kbd(it.key) : null)]), fileErr, !items.length && !fileErr ? h('div', { class: 'empty' }, empty) : null, filesBusy && items.length ? h('div', { class: 'pal-busy' }, 'Searching files…') : null);
    mark();
  };
  const run = (it) => {
    m.close();
    setTimeout(() => it.run(), 0);
  };
  q.addEventListener('input', () => {
    sel = 0;
    askFiles(q.value.trim());
    draw();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(items.length - 1, sel + 1)), mark());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)), mark());
    else if (e.key === 'Enter' && items[sel]) (e.preventDefault(), run(items[sel]));
    else if (e.key === 'Tab') {
      e.preventDefault();
      const ks = SCOPES.map(([k]) => k).filter((k) => k !== 'files' || opts.files);
      setScope(ks[(ks.indexOf(scope) + (e.shiftKey ? -1 : 1) + ks.length) % ks.length]);
    }
  });
  if (opts.scope) scope = opts.scope;
  drawScopes();
  draw();
}
