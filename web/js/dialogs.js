// Modals, menus and pickers: modal, confirm, prompt, folder picker, model picker, agent requests, palette.
import { h, $, icon, iconBtn, replace, toast, fmtTokens, skeleton, kbd, leave, errorState, loadingState } from './dom.js';
import { api } from './api.js';
import { replyUi, S } from './store.js';
import { brandMark } from './brands.js';
import { fuzzy, marked } from './composer.js';

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],a[href]';

export function modal({ title, body, actions = [], size = '', cls = '', onClose, initialFocus }) {
  const root = $('#modal-root');
  const prev = document.activeElement;
  const scrim = h('div', { class: 'scrim', onmousedown: (e) => e.target === scrim && close() });
  const bodyEl = h('div', { class: 'modal-b' }, body);
  const foot = actions.length ? h('div', { class: 'modal-f' }, actions) : null;
  const box = h('div', { class: `modal${size ? ' ' + size : ''}${cls ? ' ' + cls : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' }, h('div', { class: 'modal-h' }, h('h2', null, title), iconBtn('x', 'Close (Esc)', () => close())), bodyEl, foot);
  scrim.append(box);
  const isTop = () => [...root.children].filter((x) => !x.classList.contains('closing')).pop() === scrim;
  const onKey = (e) => {
    if (!isTop()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) (e.preventDefault(), first.focus());
    }
  };
  document.addEventListener('keydown', onKey, true);
  root.append(scrim);
  let closed = false;
  function close(val) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.classList.add('closing');
    setTimeout(() => scrim.remove(), 140);
    onClose?.(val);
    try {
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    } catch {}
  }
  setTimeout(() => {
    if (closed || !isTop()) return;
    const target = initialFocus || box.querySelector('input:not([type=checkbox]):not([type=range]),textarea,select,button.primary') || box;
    target.focus?.({ preventScroll: true });
  }, 0);
  return { close, el: box, body: bodyEl };
}

export const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`.trim(), type: 'button', onclick }, label);

export function confirmDialog(title, message, { ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({ title, size: 'sm', body: h('p', { class: 'prewrap' }, message), onClose: (v) => resolve(!!v), actions: [btn('Cancel', () => m.close(false)), btn(ok, () => m.close(true), danger ? 'danger-solid primary' : 'primary')] });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'text', value, 'aria-label': label });
    const go = () => m.close(inp.value.trim());
    inp.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const m = modal({ title, size: 'sm', body: h('label', { class: 'field' }, h('span', null, label), inp), onClose: (v) => resolve(v || null), actions: [btn('Cancel', () => m.close(null)), btn('Save', go, 'primary')] });
    setTimeout(() => inp.select(), 0);
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
    items.map((it) => (it === '-' ? h('div', { class: 'menu-sep', role: 'separator' }) : it.header ? h('div', { class: 'menu-h' }, it.header) : h('button', { class: 'menu-it' + (it.danger ? ' danger' : ''), type: 'button', role: it.on != null ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.on != null ? String(!!it.on) : null, onclick: () => pick(it) }, it.on != null ? h('span', { class: 'menu-check' }, it.on ? icon('check', 14) : null) : null, h('span', { class: 'menu-l' }, it.label), it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null))));
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
    pathIn.addEventListener('keydown', (e) => e.key === 'Enter' && load(pathIn.value.trim()));
    const m = modal({
      title: 'Choose a project folder',
      body: h('div', { class: 'stack' }, h('div', { class: 'row' }, pathIn, btn('Drives', () => load(''))), list),
      onClose: (v) => resolve(v || null),
      actions: [btn('Cancel', () => m.close(null)), btn('Use this folder', () => cur && m.close(cur), 'primary')],
    });
    load(start);
  });
}

/**
 * Searchable model list. `load()` returns the models; `onPick(model)` applies one (throw to keep the list open).
 * `loading` is the line shown while `load()` runs.
 */
export function modelPicker({ load, current, onPick, extra, loading = 'Loading models…' }) {
  const list = h('div', { class: 'list mp-list', role: 'listbox', 'aria-label': 'Models' });
  const q = h('input', { type: 'search', placeholder: 'Search models', 'aria-label': 'Search models', spellcheck: 'false' });
  const m = modal({ title: 'Choose a model', body: h('div', { class: 'stack' }, q, list), initialFocus: q });
  let models = [];
  let sel = 0;
  let shown = [];
  const choose = async (x) => {
    try {
      await onPick(x);
      m.close();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const draw = () => {
    const f = q.value.toLowerCase().trim();
    const byProv = new Map();
    shown = [];
    for (const x of models) if (!f || `${x.provider} ${x.id} ${x.name || ''}`.toLowerCase().includes(f)) (byProv.get(x.provider) || byProv.set(x.provider, []).get(x.provider)).push(x);
    const kids = [];
    if (extra && !f) {
      kids.push(h('button', { class: 'list-it' + (!current ? ' cur' : ''), type: 'button', role: 'option', onclick: () => choose(null) }, h('span', { class: 'grow' }, extra)));
      shown.push(null);
    }
    for (const [p, arr] of byProv) {
      kids.push(h('div', { class: 'list-h with-mark' }, brandMark(p, 14), S.engine?.providers?.find((q) => q.id === p)?.name || p));
      for (const x of arr) {
        const isCur = current && current.id === x.id && current.provider === x.provider;
        shown.push(x);
        kids.push(h('button', { class: 'list-it' + (isCur ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(!!isCur), onclick: () => choose(x) }, h('span', { class: 'grow ell' }, x.name || x.id), x.reasoning ? h('span', { class: 'tag' }, 'thinking') : null, x.contextWindow ? h('span', { class: 'muted small num' }, fmtTokens(x.contextWindow)) : null, isCur ? icon('check', 14) : null));
      }
    }
    if (!byProv.size && !(extra && !f)) kids.push(h('div', { class: 'empty' }, 'No matching models'));
    replace(list, kids);
    sel = Math.max(0, Math.min(sel, shown.length - 1));
    mark();
  };
  const mark = () => {
    const items = [...list.querySelectorAll('.list-it')];
    items.forEach((x, i) => x.classList.toggle('sel', i === sel));
    items[sel]?.scrollIntoView({ block: 'nearest' });
  };
  q.addEventListener('input', () => {
    sel = 0;
    draw();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), (sel = Math.min(shown.length - 1, sel + 1)), mark());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (sel = Math.max(0, sel - 1)), mark());
    else if (e.key === 'Enter' && shown.length) (e.preventDefault(), choose(shown[sel]));
  });
  const fetchModels = () => {
    replace(list, loadingState(loading, 6));
    return Promise.resolve()
      .then(load)
      .then((ms) => {
        models = ms || [];
        const i = models.findIndex((x) => current && x.id === current.id && x.provider === current.provider);
        sel = i >= 0 ? i + (extra ? 1 : 0) : 0;
        draw();
      })
      .catch((e) => list.isConnected && replace(list, errorState(e.message, { title: 'Couldn’t load the models.', retry: fetchModels })));
  };
  fetchModels();
  return m;
}

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

/** Every keyboard shortcut: [keys, what it does]. */
export const SHORTCUTS = [['Ctrl+N', 'New session'], ['Ctrl+K', 'Search conversations, files and commands'], ['Ctrl+,', 'Settings'], ['Ctrl+B', 'Sidebar'], ['Ctrl+J', 'Side panel'], ['Ctrl+L', 'Focus the message box'], ['Ctrl+F', 'Find in conversation'], ['Ctrl+Shift+O', 'Jump to one of your messages'], ['Ctrl+Shift+F', 'Focus mode'], ['Alt+1…9', 'Switch session'], ['Ctrl+Tab', 'Next session (Shift for the previous one)'], ['Ctrl+=', 'Bigger conversation text (Ctrl+- smaller, Ctrl+0 resets)'], ['Alt+↑ / Alt+↓', 'Previous / next message of yours'], ['Enter', 'Send'], ['Shift+Enter', 'New line'], ['Alt+Enter', 'Queue a message while the agent works'], ['Esc', 'Stop the agent'], ['/', 'Slash commands'], ['@', 'Mention a file'], ['↑', 'Recall your last message (when the box is empty)'], ['Select text', 'Ask about it or copy it, from the bar above the selection'], ['Right-click', 'On a conversation or project in the sidebar: its menu'], ['F2', 'Rename the conversation selected in the sidebar (or double-click it)'], ['P', 'Pin or unpin the conversation selected in the sidebar'], ['Del', 'Delete the conversation selected in the sidebar (asks first)'], ['↑ / ↓', 'Move through the sidebar list (Enter in its filter opens the first match)']];

/** Keys as keycaps: "Ctrl+Shift+F" becomes three caps joined by plus signs. */
export const keyCaps = (k) => k.split(' / ').map((alt, j) => [j ? h('span', { class: 'keys-or' }, 'or') : null, /\s/.test(alt) ? h('span', { class: 'keys-w' }, alt) : alt.split(/(?<=\S)\+(?=\S)/).map((x, i) => [i ? '+' : null, kbd(x)])]);

export function shortcutsDialog() {
  const rows = SHORTCUTS;
  modal({ title: 'Keyboard shortcuts', size: 'sm', body: h('dl', { class: 'keys' }, rows.map(([k, d]) => [h('dt', null, keyCaps(k)), h('dd', null, d)])) });
}

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
    } else items = pool.slice(0, 80);
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
