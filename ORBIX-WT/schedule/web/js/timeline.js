// The navigator: a rail at the left edge of a conversation with one dot per turn (each message of yours), at its
// real position in the transcript, and a red mark where something failed. The dot of the turn you are reading is
// lit. Hover a dot to see the message and when you sent it; click to jump there; drag on the rail to scrub.
// Alt+↑ / Alt+↓ jump between your messages. Built from the rendered transcript, so it never drifts from it.
import { h, rafThrottle } from './dom.js';

const KIND = { you: { label: 'You' }, err: { label: 'Error' } };
const MIN_GAP = 6; // px: marks closer than this merge

export class Timeline {
  /** view: the session view (needs .root, .scroller, .tin, .dock). */
  constructor(view) {
    this.view = view;
    this.track = h('div', { class: 'tl-track' });
    this.tip = h('div', { class: 'tl-tip', role: 'tooltip', hidden: true });
    this.el = h('div', { class: 'tl', role: 'navigation', 'aria-label': 'Conversation navigator', hidden: true }, this.track, this.tip);
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

  /** Turns and failures, from the transcript as it is drawn now. */
  _items() {
    const out = [];
    for (const el of this.view.tin.querySelectorAll('.msg.user, .errbox')) {
      if (el.classList.contains('errbox')) out.push({ el, kind: 'err', text: el.textContent.trim().split('\n')[0].slice(0, 90) });
      else {
        const text = (el.querySelector('.bubble')?.textContent || el.textContent).trim().replace(/\s+/g, ' ');
        out.push({ el, kind: 'you', text: text.slice(0, 120), when: el.querySelector('.msg-time')?.textContent || '' });
      }
    }
    return out;
  }

  _refresh() {
    if (this.dead) return;
    const sc = this.view.scroller;
    const H = sc.scrollHeight;
    const items = this._items();
    // Worth a rail once there are a few turns and more than a screen and a half to move through.
    const show = H > sc.clientHeight * 1.5 && items.filter((x) => x.kind === 'you').length >= 2 && this.view.root.clientWidth > 560;
    this.el.hidden = !show;
    if (!show) return;
    // The rail spans the transcript area above the message box.
    const dockH = this.view.dock?.offsetHeight || 0;
    this.el.style.bottom = `${dockH + 14}px`;
    const trackH = this.track.clientHeight || 1;
    const scTop = sc.getBoundingClientRect().top;
    // A step inside a folded turn sits where the fold is.
    const pos = (el) => (el.closest('details.work:not([open])')?.firstElementChild || el).getBoundingClientRect().top - scTop + sc.scrollTop; // layout position in the scroll content
    let lastY = -99;
    let lastKind = '';
    const frag = document.createDocumentFragment();
    this.marks = [];
    for (const it of items) {
      const y = ((pos(it.el) + Math.min(it.el.offsetHeight, 40) / 2) / H) * trackH;
      // Marks closer than a few pixels merge, so a long conversation stays readable.
      if (y - lastY < MIN_GAP && it.kind === lastKind) {
        this.marks[this.marks.length - 1].items.push(it);
        continue;
      }
      const m = h('button', { class: `tl-mark ${it.kind}`, type: 'button', tabindex: '-1', 'aria-label': `${KIND[it.kind].label}: ${it.text}` });
      m.style.top = `${y}px`;
      const rec = { m, y, at: pos(it.el), items: [it] };
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

  /** Light the dot of the turn being read: the last one that starts above a third of the way down the screen. */
  _place() {
    if (this.dead || this.el.hidden) return;
    const sc = this.view.scroller;
    const line = sc.scrollTop + sc.clientHeight / 3;
    let cur = null;
    for (const r of this.marks) if (r.items[0].kind === 'you' && r.at <= line) cur = r;
    cur ||= this.marks.find((r) => r.items[0].kind === 'you');
    for (const r of this.marks) r.m.classList.toggle('cur', r === cur);
  }

  _showTip(rec) {
    const first = rec.items[0];
    const more = rec.items.length > 1 ? ` (+${rec.items.length - 1} more)` : '';
    this.tip.replaceChildren(h('span', { class: `tl-tip-k ${first.kind}` }, first.when ? `${KIND[first.kind].label} · ${first.when}` : KIND[first.kind].label), h('span', { class: 'tl-tip-t' }, first.text + more));
    this.tip.style.top = `${rec.y}px`;
    this.tip.hidden = false;
  }

  /** Scroll so `el` sits a third of the way down the screen, and flash it so the eye finds it. */
  jumpTo(el) {
    const sc = this.view.scroller;
    const fold = el.closest('details.work:not([open])');
    if (fold) fold.open = true; // the step is inside a folded turn: show it
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
