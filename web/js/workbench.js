// Reading tools for a conversation: find (Ctrl+F) as a row above the transcript, an outline of your messages
// (Ctrl+Shift+O), a wider reading column, and focus mode (Ctrl+Shift+F), which hides everything except the
// conversation. The conversation's name and state are in the toolbar (shell.js).
import { h, icon, iconBtn, lsGet, lsSet, debounce } from './dom.js';
import { emit, textOf } from './store.js';
import { popMenu } from './dialogs.js';

const root = document.documentElement;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ================= focus mode and reading width =================

// Conversation width (Settings → Appearance): narrow, default, wide or fill. "wide" is also the View menu's switch.
const WIDTHS = ['narrow', 'default', 'wide', 'fill'];
export const colWidth = () => (WIDTHS.includes(lsGet('colw', '')) ? lsGet('colw', '') : lsGet('wide', false) === true ? 'wide' : 'default');
export function setColWidth(v) {
  const w = WIDTHS.includes(v) ? v : 'default';
  root.classList.toggle('col-narrow', w === 'narrow');
  root.classList.toggle('wide', w === 'wide');
  root.classList.toggle('col-fill', w === 'fill');
  lsSet('colw', w);
  lsSet('wide', w === 'wide');
  emit('zen');
}
setColWidth(colWidth());

export const zenOn = () => root.classList.contains('zen');
/** Focus mode lasts until it is switched off or the window is reloaded; it is not a saved setting. */
export function toggleZen(force) {
  root.classList.toggle('zen', force ?? !zenOn());
  emit('zen');
}
export function toggleWide() {
  setColWidth(root.classList.contains('wide') ? 'default' : 'wide');
}

// ================= find =================

const HL = 'orbix-find';
const HL_CUR = 'orbix-find-cur';
const canHighlight = typeof Highlight === 'function' && !!globalThis.CSS?.highlights;
const clearHighlights = () => {
  if (!canHighlight) return;
  CSS.highlights.delete(HL);
  CSS.highlights.delete(HL_CUR);
};
const MAX_HITS = 2000;

export class SessionBar {
  constructor(view) {
    this.view = view;
    this.hits = [];
    this.at = -1;

    this.q = h('input', { type: 'search', class: 'sfind-q', placeholder: 'Find in conversation', 'aria-label': 'Find in conversation', spellcheck: 'false' });
    this.count = h('span', { class: 'sfind-n num', 'aria-live': 'polite' });
    this.findRow = h('div', { class: 'sfind', role: 'search', hidden: true },
      icon('search', 14),
      this.q,
      this.count,
      iconBtn('arrow-down', 'Previous match (Shift+Enter)', () => this.step(-1), 'sm sfind-up'),
      iconBtn('arrow-down', 'Next match (Enter)', () => this.step(1), 'sm'),
      iconBtn('x', 'Close (Esc)', () => this.closeFind(), 'sm'));
    this.q.addEventListener('input', debounce(() => this.runFind(), 90));
    this.q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.preventDefault(), this.step(e.shiftKey ? -1 : 1));
      else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), this.closeFind());
    });
    this.el = h('div', { class: 'sbar-wrap' }, this.findRow);
  }

  // ---- outline ----

  /** Your messages, newest last. Choosing one scrolls to it. */
  openOutline() {
    const v = this.view;
    const mine = v.tab.messages.filter((m) => m.role === 'user' && v.els.get(m)?.isConnected);
    if (!mine.length) return;
    const items = mine.slice(-40).map((m, i, all) => {
      const text = (textOf(m.content) || '').trim().split('\n')[0] || 'Attachment';
      return {
        label: text.length > 70 ? text.slice(0, 69) + '…' : text,
        hint: m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `${mine.length - all.length + i + 1}`,
        run: () => {
          v.stick = false;
          v.timeline.jumpTo(v.els.get(m));
          v.showJump(true);
        },
      };
    });
    const anchor = document.querySelector('#topbar .tb-more') || this.findRow;
    popMenu(anchor, [{ header: plural(mine.length, 'message') + ' from you' }, ...items], { align: 'end', minWidth: 320 });
  }

  // ---- find ----

  openFind() {
    this.findRow.hidden = false;
    const sel = String(getSelection() || '').trim();
    if (sel && sel.length < 80 && !sel.includes('\n')) this.q.value = sel;
    this.q.focus();
    this.q.select();
    this.runFind();
  }

  /** `quiet` leaves the keyboard where it is (the view is going off screen). */
  closeFind(quiet = false) {
    if (this.findRow.hidden) return;
    this.findRow.hidden = true;
    this.hits = [];
    this.at = -1;
    clearHighlights();
    if (!quiet) this.view.focus();
  }

  runFind() {
    const q = this.q.value.trim().toLowerCase();
    const hits = [];
    if (q) {
      const walker = document.createTreeWalker(this.view.tin, NodeFilter.SHOW_TEXT);
      const seen = new Map(); // element -> visible? (many text nodes share a parent)
      for (let n = walker.nextNode(); n && hits.length < MAX_HITS; n = walker.nextNode()) {
        const text = n.data.toLowerCase();
        let i = text.indexOf(q);
        if (i === -1) continue;
        const p = n.parentElement;
        if (!p) continue;
        let vis = seen.get(p);
        if (vis === undefined) seen.set(p, (vis = p.checkVisibility ? p.checkVisibility() : p.offsetParent !== null));
        if (!vis) continue; // text inside a folded step
        for (; i !== -1 && hits.length < MAX_HITS; i = text.indexOf(q, i + q.length)) {
          const r = new Range();
          try {
            r.setStart(n, i);
            r.setEnd(n, Math.min(n.data.length, i + q.length));
            hits.push(r);
          } catch {
            /* a case fold that changed the length: skip this one */
          }
        }
      }
    }
    this.hits = hits;
    // Start at the first match at or below the top of what is on screen.
    const top = this.view.scroller.getBoundingClientRect().top;
    this.at = hits.length ? Math.max(0, hits.findIndex((r) => r.getBoundingClientRect().bottom >= top)) : -1;
    this.paint(!!q);
    if (hits.length) this.reveal();
  }

  paint(searched = true) {
    const n = this.hits.length;
    this.count.textContent = !searched ? '' : n ? `${this.at + 1} of ${n >= MAX_HITS ? MAX_HITS + '+' : n}` : 'No matches';
    this.findRow.classList.toggle('none', searched && !n);
    if (!canHighlight) return;
    clearHighlights();
    if (!n) return;
    CSS.highlights.set(HL, new Highlight(...this.hits));
    CSS.highlights.set(HL_CUR, new Highlight(this.hits[this.at]));
  }

  step(dir) {
    if (!this.q.value.trim()) return;
    // The conversation was redrawn since the search (a new reply, a step opened): look again.
    if (!this.hits.length || !this.hits[this.at]?.startContainer.isConnected) {
      this.runFind();
      return;
    }
    this.at = (this.at + dir + this.hits.length) % this.hits.length;
    this.paint();
    this.reveal();
  }

  reveal() {
    const r = this.hits[this.at];
    if (!r) return;
    const v = this.view;
    const sc = v.scroller;
    const box = r.getBoundingClientRect();
    const frame = sc.getBoundingClientRect();
    if (box.top >= frame.top + 60 && box.bottom <= frame.bottom - 60) return; // already comfortably on screen
    v.stick = false;
    sc.scrollTop += box.top - frame.top - sc.clientHeight / 3;
    v.showJump(sc.scrollHeight - sc.scrollTop - sc.clientHeight > 4);
  }

  destroy() {
    if (!this.findRow.hidden) clearHighlights();
  }
}
