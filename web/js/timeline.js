// A compact index of messages, not a scrollbar. Long conversations show a sample of their loaded messages.
import { h, rafThrottle } from './dom.js';

const MAX_MARKS = 18;

export class Timeline {
  /** view: the session view (needs .scroller, .tin, .stick). */
  constructor(view) {
    this.view = view;
    this.el = h('nav', { class: 'turn-map', 'aria-label': 'Jump between your messages', hidden: true });
    view.root.append(this.el);
    this.marks = [];
    this.active = -1;
    this.update = rafThrottle(() => this.markCurrent());
    view.scroller.addEventListener('scroll', this.update, { passive: true });
  }

  refresh() {
    const yours = [...this.view.tin.querySelectorAll('.msg.user')];
    const count = Math.min(MAX_MARKS, yours.length);
    this.el.hidden = count < 2;
    if (this.el.hidden) {
      this.marks = [];
      this.el.replaceChildren();
      this.active = -1;
      return;
    }
    const targets = Array.from({ length: count }, (_, i) => yours[Math.round(i * (yours.length - 1) / (count - 1))]);
    if (targets.length === this.marks.length && targets.every((t, i) => t === this.marks[i].target)) return this.update();
    const focus = this.marks.find(({ button }) => button === document.activeElement)?.target;
    this.marks = targets.map((target, i) => {
      const text = target.querySelector('.bubble')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 70);
      const label = text ? `Jump to: ${text}` : `Jump to message ${i + 1}`;
      return { target, button: h('button', { type: 'button', class: `turn-mark${count >= 6 && i < Math.floor(count / 3) ? ' tick' : ''}`, title: label, 'aria-label': label, onclick: () => this.jumpTo(target) }) };
    });
    this.active = -1;
    this.el.replaceChildren(...this.marks.map(({ button }) => button));
    this.markCurrent();
    this.marks.find(({ target }) => target === focus)?.button.focus({ preventScroll: true });
  }

  markCurrent() {
    const sc = this.view.scroller;
    if (!this.marks.length || !sc.isConnected) return;
    let index = this.marks.length - 1;
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 4) {
      const line = sc.getBoundingClientRect().top + sc.clientHeight / 3 + 1;
      index = Math.max(0, this.marks.findLastIndex(({ target }) => target.getBoundingClientRect().top <= line));
    }
    if (index === this.active) return;
    this.marks[this.active]?.button.removeAttribute('aria-current');
    this.marks[index].button.setAttribute('aria-current', 'true');
    this.active = index;
  }

  destroy() {
    this.update.cancel();
    this.view.scroller.removeEventListener('scroll', this.update);
  }

  /** Scroll so `el` sits a third of the way down the screen, and flash it so the eye finds it. */
  jumpTo(el) {
    const sc = this.view.scroller;
    const fold = el.closest('details.work:not([open])');
    if (fold) fold.open = true; // the step is inside a folded turn: show it
    this.view.stick = false;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 3;
    const root = document.documentElement;
    const still = root.classList.contains('sr') || root.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    sc.scrollTo({ top: Math.max(0, top), behavior: still ? 'auto' : 'smooth' });
    this.update();
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
}
