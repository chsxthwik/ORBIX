// The conversation timeline: a thin column of dots at the left edge of the transcript, one per message. Your
// messages are hollow, the agent's are filled, and the messages on screen are lit. Hover or focus shows the first
// line; a click (or Enter) scrolls to the message; Up and Down move between dots; Alt+Up and Alt+Down (stepYou, bound
// in keys.mjs) jump between your own messages from anywhere in the conversation.
//
// Nothing here runs on scroll. An IntersectionObserver on the transcript lights the dots of the messages in view, and
// the dot list is rebuilt only when the transcript's top-level children change (a MutationObserver, one frame later).
// Existing dots are kept and reused, so a new message adds one button instead of redrawing the strip.
import { h } from './dom.js';
import { NARROW, firstLine, dotLabel } from './timeline-text.mjs';

const still = () => {
  const root = document.documentElement;
  return root.classList.contains('sr') || root.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
};

/** The text a message starts with: your bubble, or the first block of the agent's answer. */
function messageText(el) {
  if (el.classList.contains('user')) return el.querySelector('.bubble')?.textContent || '';
  const md = el.querySelector('.md');
  const first = md && [...md.children].find((c) => c.textContent.trim());
  return (first || md || el).textContent || '';
}

export class Timeline {
  /** view: the session view (needs .root, .scroller, .tin, .stick). */
  constructor(view) {
    this.view = view;
    this.el = h('nav', { class: 'turn-map', 'aria-label': 'Conversation timeline', hidden: true });
    this.tip = h('div', { class: 'tm-tip', 'aria-hidden': 'true' });
    view.root.append(this.el, this.tip);
    this.marks = []; // { target, button, you }
    this.byTarget = new Map();
    this.seen = new Set(); // targets on screen
    this.active = -1;
    this.narrow = false;
    this.frame = 0;
    this.io = new IntersectionObserver((entries) => this.onSeen(entries), { root: view.scroller, threshold: 0 });
    this.mo = new MutationObserver(() => this.refreshSoon());
    this.mo.observe(view.tin, { childList: true });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerover', (e) => this.showTip(e.target.closest('.turn-mark')));
    this.el.addEventListener('pointerleave', () => this.hideTip());
    this.el.addEventListener('focusin', (e) => this.showTip(e.target.closest('.turn-mark')));
    this.el.addEventListener('focusout', () => this.hideTip());
    // Kept as a function property: session.js calls timeline.update() on resize and when a conversation opens.
    this.update = () => this.measure();
    this.update.cancel = () => {};
  }

  refreshSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  }

  /** Match the dots to the transcript's messages, reusing the dots that already exist. */
  refresh() {
    const tin = this.view.tin;
    const targets = [...tin.querySelectorAll(':scope > .msg.user, :scope > .msg.asst:not(.live)')];
    const keep = new Set(targets);
    for (const [target] of this.byTarget) {
      if (keep.has(target)) continue;
      this.io.unobserve(target);
      this.byTarget.delete(target);
      this.seen.delete(target);
    }
    const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
    const total = targets.length;
    this.marks = targets.map((target, i) => {
      let mark = this.byTarget.get(target);
      if (!mark) {
        const you = target.classList.contains('user');
        const button = h('button', { type: 'button', class: `turn-mark ${you ? 'you' : 'agent'}`, tabindex: '-1', onclick: () => this.jumpTo(target) });
        mark = { target, button, you, line: '' };
        this.byTarget.set(target, mark);
        this.io.observe(target);
      }
      // The text of the newest reply can still change as it settles, so labels are read again on every refresh.
      mark.line = firstLine(messageText(target));
      mark.button.setAttribute('aria-label', dotLabel(mark.you, i + 1, total, mark.line));
      mark.button.dataset.i = String(i);
      return mark;
    });
    const buttons = this.marks.map((m) => m.button);
    const same = buttons.length === this.el.children.length && buttons.every((b, i) => this.el.children[i] === b);
    if (!same) this.el.replaceChildren(...buttons);
    this.active = -1;
    this.measure();
    this.markCurrent();
    if (focused && this.el.contains(focused)) focused.focus({ preventScroll: true });
  }

  /** Show the strip only with two or more messages and room beside the text. */
  measure() {
    const sc = this.view.scroller;
    if (!sc.isConnected) return;
    this.narrow = sc.clientWidth > 0 && sc.clientWidth < NARROW;
    this.el.hidden = this.marks.length < 2 || this.narrow;
    if (this.el.hidden) this.hideTip();
  }

  onSeen(entries) {
    for (const e of entries) {
      const mark = this.byTarget.get(e.target);
      if (!mark) continue;
      if (e.isIntersecting) this.seen.add(e.target);
      else this.seen.delete(e.target);
      mark.button.classList.toggle('seen', e.isIntersecting);
    }
    this.markCurrent();
  }

  /** The current message: the first one on screen (the last one when none is). One dot is tabbable: this one. */
  markCurrent() {
    if (!this.marks.length) return;
    let index = this.marks.findIndex((m) => this.seen.has(m.target));
    if (index < 0) index = this.marks.length - 1;
    if (index === this.active) return;
    const was = this.marks[this.active];
    if (was) {
      was.button.removeAttribute('aria-current');
      if (was.button !== document.activeElement) was.button.tabIndex = -1;
    }
    const now = this.marks[index];
    now.button.setAttribute('aria-current', 'true');
    if (!this.el.contains(document.activeElement)) {
      for (const m of this.marks) m.button.tabIndex = -1;
      now.button.tabIndex = 0;
    }
    this.active = index;
    this.keepInStrip(now.button);
  }

  /** A long conversation scrolls the strip itself; keep the current dot inside it. */
  keepInStrip(b) {
    const strip = this.el;
    if (strip.scrollHeight <= strip.clientHeight) return;
    const top = b.offsetTop;
    const bottom = top + b.offsetHeight;
    if (top < strip.scrollTop) strip.scrollTop = top - 8;
    else if (bottom > strip.scrollTop + strip.clientHeight) strip.scrollTop = bottom - strip.clientHeight + 8;
  }

  /** Up and Down move between dots (a roving tab stop), Home and End go to the ends; Enter or Space activates. */
  onKey(e) {
    const at = this.marks.findIndex((m) => m.button === document.activeElement);
    if (at < 0) return;
    const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: this.marks.length - 1 }[e.key];
    if (to === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const next = this.marks[Math.max(0, Math.min(this.marks.length - 1, to))].button;
    for (const m of this.marks) m.button.tabIndex = m.button === next ? 0 : -1;
    next.focus();
    this.keepInStrip(next);
  }

  showTip(button) {
    const mark = button && this.marks[Number(button.dataset.i)];
    if (!mark || mark.button !== button || this.el.hidden) return this.hideTip();
    this.tip.textContent = mark.line || (mark.you ? 'Your message' : 'Reply');
    this.tip.classList.toggle('you', mark.you);
    const root = this.view.root.getBoundingClientRect();
    const r = button.getBoundingClientRect();
    this.tip.style.setProperty('--tip-x', `${Math.round(r.right - root.left + 6)}px`);
    this.tip.style.setProperty('--tip-y', `${Math.round(r.top + r.height / 2 - root.top)}px`);
    this.tip.classList.add('on');
  }

  hideTip() {
    this.tip.classList.remove('on');
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.io.disconnect();
    this.mo.disconnect();
    this.tip.remove();
  }

  /** Scroll so `el` sits a third of the way down the screen, and flash it so the eye finds it. */
  jumpTo(el) {
    const sc = this.view.scroller;
    const fold = el.closest('details.work:not([open])');
    if (fold) fold.open = true; // the step is inside a folded turn: show it
    this.view.stick = false;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight / 3;
    sc.scrollTo({ top: Math.max(0, top), behavior: still() ? 'auto' : 'smooth' });
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
