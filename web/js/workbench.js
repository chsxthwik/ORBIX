// The bar above a conversation: what the session is doing, its name and size, the message of yours that the reply
// on screen answers (once that message has scrolled away), and four tools for reading it:
// find in conversation (Ctrl+F), an outline of your messages (Ctrl+Shift+O), a wider reading column, and focus
// mode (Ctrl+Shift+F), which hides everything except the conversation.
import { h, icon, iconBtn, lsGet, lsSet, debounce, rafThrottle } from './dom.js';
import { on, emit, textOf } from './store.js';
import { popMenu, isApproval } from './dialogs.js';

/** Set by main.js, which owns renaming. */
export const barHandlers = { rename: null };

const root = document.documentElement;
const fmtElapsed = (sec) => (sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// ================= focus mode and reading width =================

root.classList.toggle('wide', lsGet('wide', false) === true);

export const zenOn = () => root.classList.contains('zen');
/** Focus mode lasts until it is switched off or the window is reloaded; it is not a saved setting. */
export function toggleZen(force) {
  root.classList.toggle('zen', force ?? !zenOn());
  emit('zen');
}
export function toggleWide() {
  const wide = !root.classList.contains('wide');
  root.classList.toggle('wide', wide);
  lsSet('wide', wide);
  emit('zen');
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
    this.timer = 0;

    this.state = h('span', { class: 'sbar-state' });
    this.title = h('button', { class: 'sbar-title', type: 'button', title: 'Rename session', onclick: () => barHandlers.rename?.(view.tab) });
    this.meta = h('span', { class: 'sbar-meta num' });
    this.ctxText = h('span', { class: 'ell' });
    this.ctx = h('button', { class: 'sbar-ctx', type: 'button', hidden: true, title: 'Jump to this message', onclick: () => this.jumpCtx() }, icon('message', 12), this.ctxText);
    this.findBtn = iconBtn('search', 'Find in conversation (Ctrl+F)', () => this.toggleFind(), 'sm');
    this.outlineBtn = iconBtn('list', 'Your messages (Ctrl+Shift+O)', () => this.openOutline(), 'sm');
    this.wideBtn = iconBtn('wrap', 'Wide reading column', () => toggleWide(), 'sm');
    this.zenBtn = h('button', { class: 'sbar-zen', type: 'button', onclick: () => toggleZen() });

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

    this.el = h('div', { class: 'sbar-wrap' },
      h('header', { class: 'sbar' }, this.state, this.title, this.meta, this.ctx, h('span', { class: 'grow' }), h('button', {class:'sbar-zen run-open',type:'button',title:'Run inspector (Ctrl+Shift+R)',onclick:()=>emit('run:open')},icon('activity',14),'Inspect'), this.findBtn, this.outlineBtn, this.wideBtn, this.zenBtn),
      this.findRow);
    this.offZen = on('zen', () => this.el.isConnected && this.update());
    this.track = rafThrottle(() => this.trackCtx());
    view.scroller.addEventListener('scroll', this.track, { passive: true });
    this.update();
  }

  /** Redrawn whenever the session's state changes; cheap enough to run on every status event. */
  update() {
    const t = this.view.tab;
    const waiting = t.dialogs.some(isApproval);
    const kind = t.dead ? 'dead' : waiting ? 'wait' : t.streaming ? 'run' : 'ok';
    const label = t.dead ? 'Ended' : waiting ? 'Needs your OK' : t.streaming ? 'Working' : 'Ready';
    this.elapsed = h('span', { class: 'num' });
    this.state.className = `sbar-state ${kind}`;
    this.state.replaceChildren(h('span', { class: `dot ${kind === 'wait' ? 'warn' : kind}` }), label, this.elapsed);
    this.el.classList.toggle('run', kind === 'run');
    clearInterval(this.timer);
    this.timer = 0;
    if (kind === 'run') {
      const tick = () => {
        if (!this.el.isConnected) return;
        this.elapsed.textContent = fmtElapsed(Math.max(0, Math.floor((Date.now() - (t.turnStartedAt || Date.now())) / 1000)));
      };
      tick();
      this.timer = setInterval(tick, 1000);
    }

    if (this.title.textContent !== t.name) this.title.textContent = t.name;
    const prompts = t.messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0);
    const steps = t.stats?.toolCalls || 0;
    const bits = [];
    if (prompts) bits.push(plural(prompts, 'message'));
    if (steps) bits.push(plural(steps, 'step'));
    this.meta.textContent = bits.join(' · ');
    this.outlineBtn.disabled = !prompts;

    const wide = root.classList.contains('wide');
    this.wideBtn.classList.toggle('on', wide);
    this.wideBtn.setAttribute('aria-pressed', String(wide));
    const zen = zenOn();
    this.zenBtn.classList.toggle('on', zen);
    this.zenBtn.setAttribute('aria-pressed', String(zen));
    this.zenBtn.title = zen ? 'Leave focus mode (Ctrl+Shift+F)' : 'Focus mode: only the conversation (Ctrl+Shift+F)';
    this.zenBtn.replaceChildren(icon('eye', 14), zen ? 'Exit focus' : 'Focus');
  }

  // ---- what you asked, for the reply on screen ----

  /** The last message of yours above the top of the view. Shown only once it has scrolled out of sight. */
  trackCtx() {
    const sc = this.view.scroller;
    const top = sc.getBoundingClientRect().top;
    let cur = null;
    for (const el of this.view.tin.querySelectorAll('.msg.user')) {
      if (el.getBoundingClientRect().top > top + 8) break;
      cur = el;
    }
    const show = !!cur && cur.getBoundingClientRect().bottom < top;
    this.ctxEl = show ? cur : null;
    if (show) {
      const text = (cur.querySelector('.b-text')?.textContent || 'Attachment').trim().split('\n')[0];
      if (this.ctxText.textContent !== text) this.ctxText.textContent = text;
    }
    if (this.ctx.hidden === show) {
      this.ctx.hidden = !show;
      this.meta.hidden = show;
    }
  }

  jumpCtx() {
    const v = this.view;
    if (!this.ctxEl?.isConnected) return;
    v.stick = false;
    v.timeline.jumpTo(this.ctxEl);
    v.showJump(true);
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
    popMenu(this.outlineBtn, [{ header: plural(mine.length, 'message') + ' from you' }, ...items], { align: 'end', minWidth: 320 });
  }

  // ---- find ----

  toggleFind() {
    this.findRow.hidden ? this.openFind() : this.closeFind();
  }

  openFind() {
    this.findRow.hidden = false;
    this.findBtn.classList.add('on');
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
    this.findBtn.classList.remove('on');
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
    clearInterval(this.timer);
    this.offZen?.();
    this.track.cancel?.();
    this.view.scroller.removeEventListener('scroll', this.track);
    if (!this.findRow.hidden) clearHighlights();
  }
}
