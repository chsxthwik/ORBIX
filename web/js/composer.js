// The message box, shared by the home screen and every session: text, attachments, history, and the
// `/` command and `@` file pop-ups. The owner adds its own buttons (`row`) and decides what "send" does.
import { h, icon, replace, toast, lsGet, lsSet, baseName, leave } from './dom.js';
import { api } from './api.js';

const MAX_IMAGES = 6;
const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_TEXT_FILE = 512 * 1024;
const PASTE_AS_FILE = { chars: 4000, lines: 80 }; // a paste this large becomes an attachment chip
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|sh|bash|zsh|ps1|bat|cmd|sql|graphql|proto|dockerfile|gitignore|patch|diff)$/i;

const history = () => lsGet('history', []);
const remember = (text) => lsSet('history', [...history().filter((x) => x !== text), text].slice(-100));

/**
 * Fuzzy match `q` in `s`: prefix beats word start beats substring beats a scattered subsequence.
 * Returns { score, hits } (lower score is better; hits are matched character positions) or null.
 */
export function fuzzy(q, s) {
  if (!q) return { score: s.length, hits: [] };
  const ls = s.toLowerCase();
  const lq = q.toLowerCase();
  const at = ls.indexOf(lq);
  if (at >= 0) {
    const word = at === 0 ? 0 : /[\s/_\-.:]/.test(ls[at - 1]) ? 1 : 2;
    return { score: word * 1000 + at + s.length / 100, hits: Array.from({ length: lq.length }, (_, i) => at + i) };
  }
  const hits = [];
  let gaps = 0;
  for (let i = 0, j = 0; i < ls.length && j < lq.length; i++) {
    if (ls[i] === lq[j]) {
      if (hits.length && i > hits[hits.length - 1] + 1) gaps++;
      hits.push(i);
      j++;
    }
  }
  return hits.length === lq.length ? { score: 3000 + gaps * 50 + s.length / 100, hits } : null;
}

/** Text with the matched characters wrapped in <mark>. */
export function marked(text, hits = [], offset = 0) {
  if (!hits.length) return text;
  const set = new Set(hits.map((x) => x - offset));
  const out = [];
  let run = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMark) {
      if (run) out.push(inMark ? h('mark', null, run) : run);
      run = '';
      inMark = m;
    }
    run += text[i];
  }
  if (run) out.push(inMark ? h('mark', null, run) : run);
  return out;
}

const readAs = (file, how) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error || new Error('Could not read ' + file.name));
  how === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
});

const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fenceFor = (s) => '`'.repeat(Math.max(3, ...(s.match(/`{3,}/g) || []).map((x) => x.length + 1)));
const extOf = (name) => (/\.([\w]+)$/.exec(name || '') || [])[1] || '';

/** Message text with text attachments added as fenced blocks (the agent reads them as part of the message). */
function withTextAttachments(text, items) {
  const files = items.filter((a) => a.kind === 'text');
  if (!files.length) return text;
  const parts = files.map((a) => {
    const f = fenceFor(a.text);
    return `${a.pasted ? 'Pasted text' : `File: ${a.name}`}\n${f}${a.pasted ? '' : extOf(a.name)}\n${a.text.replace(/\n$/, '')}\n${f}`;
  });
  return [text, ...parts].filter(Boolean).join('\n\n');
}

/** Files dropped anywhere on `zone` go to the composer `target()` returns (a drop hint shows while dragging). */
export function dropZone(zone, target) {
  let depth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  zone.addEventListener('dragenter', (e) => {
    if (!isFiles(e) || !target()) return;
    e.preventDefault();
    if (depth++ === 0) zone.classList.add('drop');
  });
  zone.addEventListener('dragover', (e) => isFiles(e) && target() && (e.preventDefault(), (e.dataTransfer.dropEffect = 'copy')));
  zone.addEventListener('dragleave', (e) => isFiles(e) && --depth <= 0 && ((depth = 0), zone.classList.remove('drop')));
  zone.addEventListener('drop', (e) => {
    depth = 0;
    zone.classList.remove('drop');
    const c = target();
    if (!isFiles(e) || !c) return;
    e.preventDefault();
    c.addFiles([...e.dataTransfer.files]);
    c.focus();
  });
}

export class Composer {
  /**
   * @param {object} o
   * @param {string} o.placeholder
   * @param {string} o.label             accessible name of the text box
   * @param {object} o.state             holds `draft` (string) and `attach` (array); kept by the owner (per tab)
   * @param {() => string} o.workspace   folder for @ file search ('' turns it off)
   * @param {() => object[]} [o.commands] slash commands ({ name, description, input, aliases })
   * @param {(alt: boolean) => void} o.onSubmit  Enter (alt = Alt+Enter)
   * @param {(e: KeyboardEvent) => boolean} [o.onEscape] Esc with no pop-up open; return true when handled
   * @param {() => void} [o.onChange]    text or attachments changed
   * @param {() => object} [o.model]     current model (warns when it cannot read images)
   * @param {string} [o.cls]
   */
  constructor(o) {
    this.o = o;
    this.state = o.state;
    this.state.attach ||= [];
    this.items = [];
    this.sel = 0;
    this.kind = null; // 'slash' | 'mention' while the pop-up is open
    this.histIdx = -1;
    this.histDraft = '';
    this.findSeq = 0;
    this.cache = new Map();
    this.popup = h('div', { class: 'popup', role: 'listbox', id: `pop-${Math.random().toString(36).slice(2, 8)}`, 'aria-label': 'Suggestions', hidden: true });
    this.attachEl = h('div', { class: 'attach', 'aria-label': 'Attachments' });
    this.ta = h('textarea', { class: 'c-ta', rows: 1, placeholder: o.placeholder || '', 'aria-label': o.label || 'Message', spellcheck: 'true', 'aria-autocomplete': 'list', 'aria-controls': this.popup.id, 'aria-expanded': 'false' });
    this.ta.value = this.state.draft || '';
    this.fileIn = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', onchange: (e) => (this.addFiles([...e.target.files]), (e.target.value = '')) });
    this.el = h('div', { class: `composer ${o.cls || ''}`.trim() }, this.popup, this.attachEl, this.ta, this.fileIn);
    // Chromium sizes the box to its text (field-sizing: content, max-height in CSS); older engines use JS.
    this.autoSize = !CSS.supports('field-sizing', 'content');
    this.wire();
    this.drawAttach();
  }

  get value() {
    return this.ta.value;
  }

  set value(v) {
    this.ta.value = v;
    this.state.draft = v;
    this.fit();
    this.closePopup();
    this.o.onChange?.();
  }

  /** What to send: text (with text attachments folded in) and images, or null when there is nothing. */
  payload() {
    const raw = this.ta.value.trim();
    const items = this.state.attach;
    const images = items.filter((a) => a.kind === 'image').map((a) => ({ type: 'image', data: a.b64, mimeType: a.mime }));
    const text = withTextAttachments(raw, items);
    if (!text && !images.length) return null;
    return { text, raw, images, items: [...items] };
  }

  /** Empty the box after a send; `restore(p)` puts a failed send back. */
  reset(raw) {
    if (raw) remember(raw);
    this.state.attach = [];
    this.histIdx = -1;
    this.value = '';
    this.drawAttach();
  }

  restore(p) {
    this.state.attach = p.items;
    this.value = p.raw;
    this.drawAttach();
  }

  hasContent() {
    return !!this.ta.value.trim() || this.state.attach.length > 0;
  }

  focus() {
    if (this.ta.disabled) return;
    this.ta.focus({ preventScroll: true });
  }

  fit() {
    if (!this.autoSize) return;
    this.ta.style.height = 'auto';
    this.ta.style.height = Math.min(this.ta.scrollHeight, 280) + 'px';
  }

  openFilePicker() {
    this.fileIn.click();
  }

  // ---------- events ----------
  wire() {
    const ta = this.ta;
    ta.addEventListener('input', () => {
      this.state.draft = ta.value;
      if (this.histIdx >= 0 && ta.value !== this.histShown) this.histIdx = -1;
      this.fit();
      this.updatePopup();
      this.o.onChange?.();
    });
    ta.addEventListener('keydown', (e) => this.onKey(e));
    // The caret moved without typing (click, Home/End, arrows): the token under it may have changed.
    ta.addEventListener('click', () => this.updatePopup());
    ta.addEventListener('keyup', (e) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && this.updatePopup());
    ta.addEventListener('blur', () => setTimeout(() => document.activeElement !== ta && this.closePopup(), 120));
    ta.addEventListener('paste', (e) => this.onPaste(e));
  }

  /** Make `zone` accept dropped files (images and text files) for this box. */
  dropZone(zone) {
    dropZone(zone, () => this);
  }

  onPaste(e) {
    const cd = e.clipboardData;
    const files = [...(cd?.files || [])];
    if (files.length) {
      e.preventDefault();
      return this.addFiles(files);
    }
    const text = cd?.getData('text/plain') || '';
    const lines = text.split('\n').length;
    if (text.length >= PASTE_AS_FILE.chars || lines >= PASTE_AS_FILE.lines) {
      e.preventDefault();
      this.state.attach.push({ kind: 'text', pasted: true, name: 'Pasted text', text, lines, size: text.length });
      this.drawAttach();
      this.o.onChange?.();
    }
  }

  async addFiles(files) {
    let images = this.state.attach.filter((a) => a.kind === 'image').length;
    for (const f of files) {
      const isImage = f.type.startsWith('image/');
      const isText = !isImage && (f.type.startsWith('text/') || /json|xml|javascript|typescript|x-sh|yaml|toml|sql/.test(f.type) || TEXT_EXT.test(f.name));
      try {
        if (isImage) {
          if (images >= MAX_IMAGES) {
            toast(`Up to ${MAX_IMAGES} images per message`, 'error');
            continue;
          }
          if (f.size > MAX_IMAGE) {
            toast(`${f.name} is larger than 12 MB`, 'error');
            continue;
          }
          const url = await readAs(f, 'url');
          this.state.attach.push({ kind: 'image', name: f.name || 'image', url, b64: String(url).split(',')[1], mime: f.type || 'image/png', size: f.size });
          images++;
        } else if (isText) {
          if (f.size > MAX_TEXT_FILE) {
            toast(`${f.name} is larger than 512 KB. Mention it with @ instead, so the agent reads it from disk.`, 'error', 7000);
            continue;
          }
          const text = await readAs(f, 'text');
          if (/\u0000/.test(text.slice(0, 4096))) {
            toast(`${f.name} looks like a binary file`, 'error');
            continue;
          }
          this.state.attach.push({ kind: 'text', name: f.name, text, lines: text.split('\n').length, size: f.size });
        } else toast(`${f.name || 'This file'}: only images and text files can be attached`, 'error');
      } catch (er) {
        toast(er.message, 'error');
      }
    }
    if (images && this.o.model?.()?.input && !this.o.model().input.includes('image')) toast('This model may not read images. Choose a model with vision to use them.', 'info', 7000);
    this.drawAttach();
    this.o.onChange?.();
  }

  drawAttach() {
    const items = this.state.attach;
    replace(this.attachEl, items.map((a, i) => {
      const rm = h('button', { class: 'att-x', type: 'button', title: 'Remove', 'aria-label': `Remove ${a.name}` }, icon('x', 11));
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = rm.closest('.att');
        leave(chip, { then: () => {
          this.state.attach = this.state.attach.filter((x) => x !== a);
          this.drawAttach();
          this.o.onChange?.();
        } });
        this.focus();
      });
      if (a.kind === 'image') return h('div', { class: 'att thumb', title: `${a.name} · ${fmtSize(a.size || 0)}` }, h('img', { src: a.url, alt: a.name }), rm);
      const chip = h('div', { class: 'att file', title: a.pasted ? 'Click to edit it as text' : a.name, tabindex: a.pasted ? '0' : null }, h('span', { class: 'att-ico' }, icon(a.pasted ? 'list' : 'file', 14)), h('span', { class: 'att-t' }, h('b', { class: 'ell' }, a.name), h('span', { class: 'att-m' }, `${a.lines} line${a.lines === 1 ? '' : 's'} · ${fmtSize(a.size || a.text.length)}`)), rm);
      if (a.pasted) {
        const expand = () => {
          const pos = this.ta.selectionStart;
          this.state.attach = this.state.attach.filter((x) => x !== a);
          const v = this.ta.value;
          this.value = v.slice(0, pos) + a.text + v.slice(pos);
          this.drawAttach();
          this.focus();
        };
        chip.addEventListener('click', expand);
        chip.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), expand()));
      }
      return chip;
    }));
    this.el.classList.toggle('has-att', items.length > 0);
  }

  onKey(e) {
    if (e.isComposing || e.keyCode === 229) return; // IME: Enter confirms the word, it does not send
    const open = !this.popup.hidden && this.items.length;
    if (open) {
      const n = this.items.length;
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) return e.preventDefault(), this.select((this.sel + 1) % n);
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) return e.preventDefault(), this.select((this.sel - 1 + n) % n);
      if (e.key === 'Tab' && !e.shiftKey) return e.preventDefault(), this.pick(this.items[this.sel]);
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        const it = this.items[this.sel];
        // A command typed in full sends on Enter; anything else is completed first.
        if (it && !(it.exact && it.exact === this.ta.value.trim())) return e.preventDefault(), this.pick(it);
      }
      if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), this.closePopup();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.o.onSubmit(e.altKey);
      return;
    }
    if (e.key === 'Escape') {
      if (this.o.onEscape?.(e)) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && this.ta.selectionStart === 0 && this.ta.selectionEnd === 0 && (!this.ta.value || this.histIdx >= 0)) {
      const hst = history();
      if (this.histIdx + 1 < hst.length) {
        e.preventDefault();
        if (this.histIdx < 0) this.histDraft = this.ta.value;
        this.showHistory(this.histIdx + 1, hst);
        this.ta.selectionStart = this.ta.selectionEnd = 0;
      }
    } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && this.histIdx >= 0 && this.ta.selectionStart === this.ta.value.length) {
      e.preventDefault();
      if (this.histIdx === 0) {
        this.histIdx = -1;
        this.setQuiet(this.histDraft);
      } else this.showHistory(this.histIdx - 1, history());
    }
  }

  showHistory(i, hst) {
    this.histIdx = i;
    this.setQuiet(hst[hst.length - 1 - i] || '');
    this.histShown = this.ta.value;
  }

  setQuiet(v) {
    this.ta.value = v;
    this.state.draft = v;
    this.fit();
    this.o.onChange?.();
  }

  // ---------- pop-up ----------
  token() {
    const v = this.ta.value;
    const pos = this.ta.selectionStart;
    if (this.o.commands && /^\/\S*$/.test(v.slice(0, pos)) && !/\s/.test(v)) return { kind: 'slash', q: v.slice(1) };
    if (!this.o.workspace?.()) return null;
    const m = /(?:^|\s)@([^\s@]*)$/.exec(v.slice(0, pos));
    return m ? { kind: 'mention', q: m[1] } : null;
  }

  updatePopup() {
    const tk = this.token();
    if (!tk) return this.closePopup();
    if (tk.kind === 'slash') {
      const cmds = this.o.commands() || [];
      const scored = [];
      for (const c of cmds) {
        let best = fuzzy(tk.q, c.name);
        for (const a of c.aliases || []) {
          const s = fuzzy(tk.q, a);
          if (s && (!best || s.score < best.score)) best = { ...s, hits: [] };
        }
        if (best) scored.push([best, c]);
      }
      scored.sort((a, b) => a[0].score - b[0].score);
      this.show('slash', scored.slice(0, 50).map(([s, c]) => ({ insert: `/${c.name} `, exact: `/${c.name}`, label: ['/', marked(c.name, s.hits)], desc: [c.input?.hint ? h('span', { class: 'pop-hint' }, c.input.hint) : null, c.description || ''] })), tk.q ? 'No matching commands' : 'No commands');
      return;
    }
    this.findFiles(tk);
  }

  /** @ file search: answers are cached per query, stale answers are dropped, and the old list stays until a new one arrives. */
  findFiles(tk) {
    const ws = this.o.workspace();
    const key = ws + '\u0000' + tk.q;
    const render = (files) => {
      const now = this.token();
      if (!now || now.kind !== 'mention' || now.q !== tk.q) return;
      const scored = files.map((f) => {
        const base = baseName(f);
        const s = fuzzy(tk.q, base) || fuzzy(tk.q, f);
        return [s ? s.score : 9999, f, base, fuzzy(tk.q, base)?.hits || []];
      }).sort((a, b) => a[0] - b[0]);
      this.show('mention', scored.slice(0, 40).map(([, f, base, hits]) => ({ insert: `@${f} `, mention: true, label: marked(base, hits), desc: f.includes('/') ? f.slice(0, f.length - base.length - 1) : '' })), tk.q ? 'No matching files' : 'No files');
    };
    if (this.cache.has(key)) return render(this.cache.get(key));
    const seq = ++this.findSeq;
    clearTimeout(this.findT);
    if (this.popup.hidden || this.kind !== 'mention') this.show('mention', [], 'Searching…', true);
    this.findT = setTimeout(async () => {
      try {
        const j = await api.get(`/api/fs/find?root=${encodeURIComponent(ws)}&q=${encodeURIComponent(tk.q)}`);
        this.cache.set(key, j.files || []);
        if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
        if (seq === this.findSeq) render(j.files || []);
      } catch (er) {
        if (seq === this.findSeq) this.show('mention', [], er.message);
      }
    }, 60);
  }

  show(kind, items, emptyText, loading = false) {
    this.kind = kind;
    this.items = items;
    this.sel = Math.min(this.sel, Math.max(0, items.length - 1));
    if (this.lastKind !== kind) this.sel = 0;
    this.lastKind = kind;
    const head = h('div', { class: 'pop-h' }, kind === 'slash' ? 'Commands' : 'Files', h('span', null, h('kbd', null, '↑↓'), ' move  ', h('kbd', null, 'Tab'), ' complete  ', h('kbd', null, 'Esc'), ' close'));
    replace(this.popup, head, items.length ? items.map((it, i) => h('div', { class: 'pop-it', id: `${this.popup.id}-${i}`, role: 'option', 'aria-selected': 'false', onmousedown: (e) => (e.preventDefault(), this.pick(it)), onmousemove: () => this.sel !== i && this.select(i) }, h('span', { class: 'pop-l' }, it.label), h('span', { class: 'pop-d ell' }, it.desc))) : h('div', { class: 'pop-empty' }, loading ? h('span', { class: 'skel-l pop-skel' }) : emptyText));
    if (this.popup.hidden) {
      this.popup.hidden = false;
      this.popup.classList.remove('leaving');
    }
    this.ta.setAttribute('aria-expanded', 'true');
    this.select(this.sel);
  }

  select(i) {
    this.sel = i;
    const rows = this.popup.querySelectorAll('.pop-it');
    rows.forEach((r, k) => {
      r.classList.toggle('sel', k === i);
      r.setAttribute('aria-selected', String(k === i));
    });
    const cur = rows[i];
    if (cur) {
      cur.scrollIntoView({ block: 'nearest' });
      this.ta.setAttribute('aria-activedescendant', cur.id);
    } else this.ta.removeAttribute('aria-activedescendant');
  }

  closePopup() {
    clearTimeout(this.findT);
    this.findSeq++;
    this.items = [];
    this.kind = null;
    this.ta.setAttribute('aria-expanded', 'false');
    this.ta.removeAttribute('aria-activedescendant');
    if (!this.popup.hidden) leave(this.popup, { hide: true });
  }

  pick(it) {
    if (!it) return;
    const ta = this.ta;
    if (it.mention) {
      const pos = ta.selectionStart;
      const before = ta.value.slice(0, pos).replace(/@[^\s@]*$/, '');
      const after = ta.value.slice(pos).replace(/^\S*/, '');
      ta.value = before + it.insert + after.replace(/^ /, '');
      ta.selectionStart = ta.selectionEnd = (before + it.insert).length;
    } else ta.value = it.insert;
    this.state.draft = ta.value;
    this.closePopup();
    this.fit();
    this.o.onChange?.();
    ta.focus();
  }
}
