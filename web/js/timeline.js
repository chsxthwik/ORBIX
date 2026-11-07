// Session timeline: a rail in the right margin of a conversation that maps every step, top to bottom, at its real
// position in the transcript. Your messages (orange), file changes (teal), commands, reads, and errors (red).
// Hover a mark to see what it was; click it to jump there; drag on the rail to scrub. A box shows the part of the
// conversation on screen. Alt+↑ / Alt+↓ jump between your messages.
// It is built from what the transcript shows (the rendered cards and messages), so it can never drift from it.
import { h, rafThrottle } from './dom.js';

const KIND = {
  you: { label: 'You' },
  edit: { label: 'Changed' },
  cmd: { label: 'Ran' },
  read: { label: 'Looked at' },
  web: { label: 'Web' },
  agent: { label: 'Helpers' },
  err: { label: 'Error' },
};
const toolKind = (name) => (name === 'edit' || name === 'write' ? 'edit' : name === 'bash' ? 'cmd' : name === 'task' ? 'agent' : name === 'web_fetch' || name === 'web_search' ? 'web' : 'read');
const MIN_GAP = 3; // px: marks closer than this merge visually (the rail stays readable on long sessions)

export class Timeline {
  /** view: the session view (needs .root, .scroller, .tin, .dock). */
  constructor(view) {
    this.view = view;
    this.track = h('div', { class: 'tl-track' });
    this.box = h('div', { class: 'tl-view', 'aria-hidden': 'true' });
    this.tip = h('div', { class: 'tl-tip', role: 'tooltip', hidden: true });
    this.el = h('div', { class: 'tl', role: 'navigation', 'aria-label': 'Conversation timeline', hidden: true }, this.track, this.box, this.tip);
    this.marks = [];
    this.dead = false;
    this.refresh = rafThrottle(() => this._refresh());
    this.place = rafThrottle(() => this._place());
    view.root.append(this.el);
    view.scroller.addEventListener('scroll', this.place, { passive: true });
    this.ro = [new ResizeObserver(this.refresh), new ResizeObserver(this.refresh)];
    this.ro[0].observe(view.scroller);
    this.ro[1].observe(view.tin);
    // Cards open and close, tool steps finish, messages arrive: rebuild, at most once a frame.
    this.mo = new MutationObserver(this.refresh);
    this.mo.observe(view.tin, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    this._scrub();
  }

  /** The session view is gone: stop observing a detached transcript and release its nodes. */
  destroy() {
    this.dead = true;
    this.refresh.cancel();
    this.place.cancel();
    this.mo.disconnect();
    for (const r of this.ro) r.disconnect();
    this.view.scroller.removeEventListener('scroll', this.place);
    this.el.remove();
    this.marks = [];
  }

  /** Items from the transcript as it is drawn now. */
  _items() {
    const out = [];
    for (const el of this.view.tin.querySelectorAll('.msg.user, .tool[data-id], .errbox')) {
      if (el.classList.contains('errbox')) {
        out.push({ el, kind: 'err', text: el.textContent.trim().split('\n')[0].slice(0, 90) });
      } else if (el.classList.contains('user')) {
        const text = (el.querySelector('.bubble')?.textContent || el.textContent).trim().replace(/\s+/g, ' ');
        out.push({ el, kind: 'you', text: text.slice(0, 90) });
      } else {
        const name = el.dataset.tool || '';
        const failed = el.classList.contains('error') || el.classList.contains('denied');
        const sum = (el.querySelector('.tool-sum')?.textContent || '').trim();
        out.push({ el, kind: failed ? 'err' : toolKind(name), tool: name, text: `${name}${sum ? ' · ' + sum : ''}`.slice(0, 90), failed });
      }
    }
    return out;
  }

  _refresh() {
    if (this.dead) return;
    const sc = this.view.scroller;
    const H = sc.scrollHeight;
    const items = this._items();
    // Only worth a rail when the conversation is longer than about two screens and has a few steps.
    const show = H > sc.clientHeight * 1.6 && items.length >= 4 && this.view.root.clientWidth > 900;
    this.el.hidden = !show;
    if (!show) return;
    // The rail spans the transcript area above the message box.
    const dockH = this.view.dock?.offsetHeight || 0;
    this.el.style.bottom = `${dockH + 14}px`;
    const trackH = this.track.clientHeight || 1;
    const scTop = sc.getBoundingClientRect().top;
    const pos = (el) => el.getBoundingClientRect().top - scTop + sc.scrollTop; // layout position in the scroll content
    let lastY = -99;
    let lastKind = '';
    const frag = document.createDocumentFragment();
    this.marks = [];
    for (const it of items) {
      const y = ((pos(it.el) + Math.min(it.el.offsetHeight, 40) / 2) / H) * trackH;
      // A cluster of the same kind becomes one mark; your messages and errors always get their own.
      if (y - lastY < MIN_GAP && it.kind === lastKind && it.kind !== 'you' && it.kind !== 'err') {
        const prev = this.marks[this.marks.length - 1];
        prev.items.push(it);
        continue;
      }
      const m = h('button', { class: `tl-mark ${it.kind}`, type: 'button', tabindex: '-1', 'aria-label': `${KIND[it.kind].label}: ${it.text}` });
      m.style.top = `${y}px`;
      const rec = { m, y, items: [it] };
      m.addEventListener('pointerenter', () => this._showTip(rec));
      m.addEventListener('pointerleave', () => (this.tip.hidden = true));
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        this.jumpTo(rec.items[0].el);
      });
      this.marks.push(rec);
      frag.append(m);
      lastY = y;
      lastKind = it.kind;
    }
    this.track.replaceChildren(frag);
    this._place();
  }

  /** The box that shows which part of the conversation is on screen. */
  _place() {
    if (this.dead || this.el.hidden) return;
    const sc = this.view.scroller;
    const trackH = this.track.clientHeight || 1;
    const H = sc.scrollHeight || 1;
    this.box.style.top = `${(sc.scrollTop / H) * trackH}px`;
    this.box.style.height = `${Math.max(14, (sc.clientHeight / H) * trackH)}px`;
  }

  _showTip(rec) {
    const first = rec.items[0];
    const more = rec.items.length > 1 ? ` (+${rec.items.length - 1} more)` : '';
    this.tip.replaceChildren(h('span', { class: `tl-tip-k ${first.kind}` }, KIND[first.kind].label), h('span', { class: 'tl-tip-t' }, first.text + more));
    this.tip.style.top = `${rec.y}px`;
    this.tip.hidden = false;
  }

  /** Scroll so `el` sits a third of the way down the screen, and flash it so the eye finds it. */
  jumpTo(el) {
    const sc = this.view.scroller;
    this.view.stick = false;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 3;
    sc.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('tl-flash');
    void el.offsetWidth; // restart the flash if it is already playing
    el.classList.add('tl-flash');
    setTimeout(() => el.classList.remove('tl-flash'), 1400);
  }

  /** Jump to the previous (-1) or next (+1) message of yours, relative to what is on screen. */
  stepYou(dir) {
    const sc = this.view.scroller;
    const scTop = sc.getBoundingClientRect().top;
    const pos = (el) => el.getBoundingClientRect().top - scTop + sc.scrollTop;
    const line = sc.scrollTop + sc.clientHeight / 3;
    const bottom = sc.scrollTop + sc.clientHeight;
    const yours = [...this.view.tin.querySelectorAll('.msg.user')];
    if (!yours.length) return false;
    let target;
    if (dir < 0) {
      // The last message that has started on screen. If it already sits on the reading line, take the one before it.
      const seen = yours.filter((e) => pos(e) < bottom - 24);
      target = seen[seen.length - 1];
      if (target && Math.abs(pos(target) - line) < 12) target = seen[seen.length - 2];
    } else {
      target = yours.find((e) => pos(e) > line + 8);
    }
    if (target) this.jumpTo(target);
    return !!target;
  }

  /** Press and drag on the rail to scrub through the conversation. */
  _scrub() {
    const to = (e) => {
      const r = this.track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const sc = this.view.scroller;
      this.view.stick = false;
      sc.scrollTop = f * sc.scrollHeight - sc.clientHeight / 2;
    };
    this.track.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tl-mark')) return;
      e.preventDefault();
      this.track.setPointerCapture(e.pointerId);
      this.el.classList.add('scrub');
      to(e);
      const move = (ev) => to(ev);
      const up = () => {
        this.el.classList.remove('scrub');
        this.track.removeEventListener('pointermove', move);
        this.track.removeEventListener('pointerup', up);
        this.track.removeEventListener('pointercancel', up);
      };
      this.track.addEventListener('pointermove', move);
      this.track.addEventListener('pointerup', up);
      this.track.addEventListener('pointercancel', up);
    });
  }
}
