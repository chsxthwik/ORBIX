// The conversation timeline: a thin column of marks 24px outside the transcript's left edge, one per turn (each of your
// messages starts one; the replies belong to it). The current turn's mark is the strongest, turns on screen a step
// below. Hover or focus shows a card after a short delay: your message on one line and the start of the reply; Esc
// closes it. A click (or Enter) scrolls to the turn; Up and Down move between marks; Alt+Up and Alt+Down (stepYou,
// bound in keys.mjs) jump between your own messages from anywhere in the conversation. Hidden in windows under 1100px.
//
// Nothing here runs on scroll. An IntersectionObserver on the transcript lights the turns in view, and
// the dot list is rebuilt only when the transcript's top-level children change (a MutationObserver, one frame later).
// The observer watches only the messages around the view (WATCH on each side of those on screen), not all of them:
// the browser works out every watched element's intersection on every frame, which with 2,000 messages was the
// largest single cost of scrolling. The watched range follows the reader; after a far jump one pass over all
// messages finds the view again (findView).
// Existing dots are kept and reused, so a new message adds one button instead of redrawing the strip.
// Nothing here reads layout either: sizes come from ResizeObservers and dot positions from arithmetic, because a
// layout read with a long transcript waiting to be laid out costs hundreds of milliseconds.
import { h } from './dom.js';
import { MIN_WINDOW, TIP_CHARS, firstLine, dotLabel } from './timeline-text.mjs';

const still = () => {
  const root = document.documentElement;
  return root.classList.contains('sr') || root.classList.contains('no-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
};

const TIP_DELAY = 150; // ms before the card shows; moving to another mark while it shows switches at once
const WATCH = 24; // messages kept under watch on each side of the ones on screen
const REPLY_CHARS = 240; // the card clamps the reply to two lines; this only bounds the text put in it

/** The text of your message. */
const messageText = (el) => el.querySelector('.bubble')?.textContent || '';

/** The start of the turn's answer: the last reply drawn after your message (outside the steps' fold), flattened. */
function replyText(user) {
  let answer = null;
  for (let el = user.nextElementSibling; el && !el.matches('.msg.user'); el = el.nextElementSibling) {
    if (el.matches('.msg.asst') && el.querySelector(':scope > .md')) answer = el;
  }
  const text = answer ? [...answer.querySelectorAll(':scope > .md')].map((md) => md.textContent).join(' ') : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, REPLY_CHARS);
}

export class Timeline {
  /** view: the session view (needs .root, .scroller, .tin, .stick). */
  constructor(view) {
    this.view = view;
    this.el = h('nav', { class: 'turn-map', 'aria-label': 'Conversation timeline', hidden: true });
    // The card repeats the mark's label (which already names your message) for the eye, so screen readers skip it.
    this.tipQ = h('div', { class: 'tm-tip-q' });
    this.tipA = h('div', { class: 'tm-tip-a' });
    this.tip = h('div', { class: 'tm-tip', 'aria-hidden': 'true' }, this.tipQ, this.tipA);
    this.tipFor = null; // the mark whose card shows (or is about to)
    this.tipTimer = 0;
    // The dots sit on a track that slides (a transform) when there are more than fit: moving it never forces layout,
    // which setting scrollTop would on every change of the current message.
    this.track = h('div', { class: 'tm-track' });
    this.el.append(this.track);
    view.root.append(this.el, this.tip);
    this.marks = []; // one per turn: { target (your message), button, line, label }
    this.byTarget = new Map(); // your message -> its mark
    this.turnOf = new Map(); // every message in the transcript -> the index of its turn
    this.order = []; // the messages of the transcript, top to bottom
    this.at = new Map(); // message -> its index in `order`
    this.observed = new Set(); // the messages the IntersectionObserver watches: a range of `order` around the view
    this.finder = null; // the one-off observer of findView, while it runs
    this.foundAt = 0; // when findView last finished
    this.seen = new Set(); // messages on screen
    this.seenTurns = new Map(); // turn index -> how many of its messages are on screen
    this.active = -1;
    this.narrow = false;
    this.width = 0; // the transcript's width, from a ResizeObserver
    this.stripH = 0; // the strip's height, from a ResizeObserver
    this.stripTop = 0; // how far the track is slid up
    this.frame = 0;
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === view.scroller) this.width = e.contentRect.width;
        else this.stripH = e.contentRect.height;
      }
      this.measure();
    });
    this.ro.observe(view.scroller);
    this.ro.observe(this.el);
    this.io = new IntersectionObserver((entries) => this.onSeen(entries), { root: view.scroller, threshold: 0 });
    this.mo = new MutationObserver(() => this.refreshSoon());
    this.mo.observe(view.tin, { childList: true });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerover', (e) => this.tipSoon(e.target.closest('.turn-mark')));
    this.el.addEventListener('pointerleave', () => this.hideTip());
    this.el.addEventListener('focusin', (e) => this.tipSoon(e.target.closest('.turn-mark')));
    this.el.addEventListener('focusout', (e) => this.el.contains(e.relatedTarget) || this.hideTip());
    // Kept as a function property: session.js calls timeline.update() on resize and when a conversation opens.
    this.update = () => {
      this.measure();
      if (!this.seen.size) this.findView(); // shown again, or resized: the watched range may be elsewhere
    };
    this.update.cancel = () => {};
  }

  refreshSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  }

  /** Match the dots to your messages, reusing the dots that already exist; replies map to the turn before them. */
  refresh() {
    const tin = this.view.tin;
    const all = [...tin.querySelectorAll(':scope > .msg.user, :scope > .msg.asst:not(.live)')];
    const keep = new Set(all);
    for (const el of this.observed) {
      if (keep.has(el)) continue;
      this.io.unobserve(el);
      this.observed.delete(el);
    }
    for (const el of this.seen) if (!keep.has(el)) this.seen.delete(el);
    for (const el of this.byTarget.keys()) if (!keep.has(el)) this.byTarget.delete(el);
    this.turnOf.clear();
    this.order = all;
    this.at = new Map(all.map((el, i) => [el, i]));
    const users = [];
    for (const el of all) {
      if (el.classList.contains('user')) users.push(el);
      if (users.length) this.turnOf.set(el, users.length - 1);
    }
    // Keep watching around what is on screen. With nothing on screen yet: a reader at the bottom (a conversation
    // that just opened, a new message) is at the last messages; anywhere else, look for the view.
    if (this.seen.size) this.follow();
    else if (this.view.stick !== false) this.watch(all.length - 1 - 2 * WATCH, all.length - 1);
    else this.findView();
    const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
    const total = users.length;
    this.marks = users.map((target, i) => {
      let mark = this.byTarget.get(target);
      if (!mark) {
        const button = h('button', { type: 'button', class: 'turn-mark', tabindex: '-1', onclick: () => this.jumpTo(target) });
        mark = { target, button, line: null, label: '' };
        this.byTarget.set(target, mark);
      }
      // A message's first line is read once; your newest message can still be edited into the box, so it is read again.
      if (mark.line === null || i >= total - 1) mark.line = firstLine(messageText(target), TIP_CHARS);
      const label = dotLabel(i + 1, total, mark.line);
      if (label !== mark.label) mark.button.setAttribute('aria-label', (mark.label = label));
      mark.button.dataset.i = String(i);
      return mark;
    });
    // Which turns are on screen, again (the turn numbers moved when older messages were added above).
    this.seenTurns.clear();
    for (const el of this.seen) this.countTurn(el, 1);
    for (const m of this.marks) m.button.classList.toggle('seen', this.seenTurns.has(this.turnOf.get(m.target)));
    const buttons = this.marks.map((m) => m.button);
    const same = buttons.length === this.track.children.length && buttons.every((b, i) => this.track.children[i] === b);
    if (!same) this.track.replaceChildren(...buttons);
    this.active = -1;
    this.measure();
    this.markCurrent();
    if (focused && this.el.contains(focused)) focused.focus({ preventScroll: true });
  }

  countTurn(el, delta) {
    const turn = this.turnOf.get(el);
    if (turn === undefined) return;
    const n = (this.seenTurns.get(turn) || 0) + delta;
    if (n > 0) this.seenTurns.set(turn, n);
    else this.seenTurns.delete(turn);
  }

  /** Show the strip only with two or more messages and room beside the text. */
  measure() {
    this.narrow = innerWidth < MIN_WINDOW;
    const hide = this.marks.length < 2 || this.narrow;
    if (this.el.hidden !== hide) this.el.hidden = hide;
    if (hide) this.hideTip();
  }

  /** Message `el` came on screen or left it: keep the count of its turn and that turn's dot. */
  setSeen(el, on) {
    if (on === this.seen.has(el)) return;
    if (on) this.seen.add(el);
    else this.seen.delete(el);
    this.countTurn(el, on ? 1 : -1);
    const turn = this.turnOf.get(el);
    if (turn !== undefined) this.marks[turn]?.button.classList.toggle('seen', this.seenTurns.has(turn));
  }

  onSeen(entries) {
    const had = this.seen.size;
    for (const e of entries) if (this.observed.has(e.target)) this.setSeen(e.target, e.isIntersecting);
    if (this.seen.size) {
      this.markCurrent();
      this.follow();
    } else if (had) this.findView(); // every watched message left the screen at once: a jump past the watched range
    else this.markCurrent();
  }

  /** The topmost message on screen, or null. No layout read: it comes from what the observer reported. */
  firstSeen() {
    let first = null;
    let at = Infinity;
    for (const el of this.seen) {
      const i = this.at.get(el);
      if (i !== undefined && i < at) (at = i), (first = el);
    }
    return first;
  }

  /** Watch messages lo..hi of `order` and no others. */
  watch(lo, hi) {
    lo = Math.max(0, lo);
    hi = Math.min(this.order.length - 1, hi);
    for (const el of this.observed) {
      const i = this.at.get(el);
      if (i !== undefined && i >= lo && i <= hi) continue;
      this.io.unobserve(el);
      this.observed.delete(el);
      this.setSeen(el, false);
    }
    for (let i = lo; i <= hi; i++) {
      const el = this.order[i];
      if (!this.observed.has(el)) (this.observed.add(el), this.io.observe(el));
    }
  }

  /** Move the watched range so it stays WATCH messages wider, on each side, than the messages on screen. */
  follow() {
    let lo = Infinity;
    let hi = -1;
    for (const el of this.seen) {
      const i = this.at.get(el);
      if (i === undefined) continue;
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }
    if (hi >= 0) this.watch(lo - WATCH, hi + WATCH);
  }

  /**
   * Nothing watched is on screen (a jump to a far turn, Find, the scrollbar dragged a long way): find where the
   * view is. One throwaway observer looks at every message once; its first report carries each one's position,
   * so this reads no layout. With no message on screen at all (a long reply still being written fills it), the
   * range goes around the gap the view is in, and the next message to scroll into view is a watched one.
   */
  findView() {
    if (this.finder || !this.order.length || !this.view.scroller.isConnected) return;
    const finder = (this.finder = new IntersectionObserver((entries) => {
      finder.disconnect();
      if (this.finder !== finder) return;
      this.finder = null;
      this.foundAt = performance.now();
      if (!entries.some((e) => e.rootBounds)) return; // the view left the screen meanwhile; update() looks again
      let lo = Infinity;
      let hi = -1;
      let above = -1;
      for (const e of entries) {
        const i = this.at.get(e.target);
        if (i === undefined) continue;
        if (e.isIntersecting) {
          if (i < lo) lo = i;
          if (i > hi) hi = i;
        } else if (e.rootBounds && e.boundingClientRect.bottom <= e.rootBounds.top && i > above) above = i;
      }
      if (hi < 0) (lo = above), (hi = above + 1);
      this.watch(lo - WATCH, hi + WATCH); // the main observer reports the ones on screen next
      if (!this.seen.size) this.markCurrent();
    }, { root: this.view.scroller, threshold: 0 }));
    for (const el of this.order) finder.observe(el);
  }

  /**
   * The view calls this once per frame while the transcript scrolls. It does nothing while a watched message is on
   * screen. With none (the range was left behind without any watched message crossing the view), it looks for the
   * view, at most every 300 ms.
   */
  scrolled() {
    if (this.seen.size || this.finder || performance.now() - this.foundAt < 300) return;
    this.findView();
  }

  /** The current turn: the first with a message on screen (the last turn when none is). One dot is tabbable: this one. */
  markCurrent() {
    if (!this.marks.length) return;
    let index = this.marks.findIndex((_, i) => this.seenTurns.has(i));
    if (index < 0) index = this.marks.length - 1;
    if (index === this.active) return;
    const was = this.marks[this.active];
    const now = this.marks[index];
    const inside = this.el.contains(document.activeElement);
    if (was) {
      was.button.removeAttribute('aria-current');
      if (!inside) was.button.tabIndex = -1;
    }
    now.button.setAttribute('aria-current', 'true');
    // The tab stop follows the current dot, unless the reader is moving through the dots with the keyboard.
    if (!inside) {
      if (this.stop && this.stop !== now.button) this.stop.tabIndex = -1;
      now.button.tabIndex = 0;
      this.stop = now.button;
    }
    this.active = index;
    this.keepInStrip(index);
  }

  /** A long conversation slides the track; keep dot `i` in view. Positions are arithmetic, not layout reads. */
  keepInStrip(i) {
    const DOT = 16; // .turn-mark height in transcript.css
    const view = this.stripH; // the strip's content height, inside its padding
    const total = this.marks.length * DOT;
    if (!view || total <= view + 1) {
      if (this.stripTop) this.track.style.transform = '';
      this.stripTop = 0;
      return;
    }
    const top = i * DOT;
    let to = this.stripTop;
    if (top < to + DOT) to = top - DOT;
    else if (top + DOT > to + view - DOT) to = top + 2 * DOT - view;
    to = Math.max(0, Math.min(total - view, to));
    if (to !== this.stripTop) this.track.style.transform = `translateY(${-(this.stripTop = to)}px)`;
  }

  /** Up and Down move between dots (a roving tab stop), Home and End go to the ends; Enter or Space activates. */
  onKey(e) {
    const at = this.marks.findIndex((m) => m.button === document.activeElement);
    if (at < 0) return;
    if (e.key === 'Escape' && this.tipFor) {
      e.preventDefault();
      e.stopPropagation(); // Esc closes the card only; it does not also stop the agent
      this.hideTip();
      return;
    }
    const to = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: this.marks.length - 1 }[e.key];
    if (to === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const next = this.marks[Math.max(0, Math.min(this.marks.length - 1, to))].button;
    for (const m of this.marks) m.button.tabIndex = m.button === next ? 0 : -1;
    next.focus({ preventScroll: true }); // the track slides instead (keepInStrip)
    this.stop = next;
    this.keepInStrip(this.marks.indexOf(this.marks.find((m) => m.button === next)));
  }

  /** Show `button`'s card: after TIP_DELAY, or at once when another mark's card already shows. */
  tipSoon(button) {
    const mark = button && this.marks[Number(button.dataset.i)];
    if (!mark || mark.button !== button || this.el.hidden) return this.hideTip();
    if (this.tipFor === mark) return;
    const showing = this.tip.classList.contains('on');
    clearTimeout(this.tipTimer);
    this.tipFor = mark;
    if (showing) this.showTip(mark);
    else this.tipTimer = setTimeout(() => this.showTip(mark), TIP_DELAY);
  }

  /** Fill the card and place it right of the mark, centred on it, kept inside the view. */
  showTip(mark) {
    if (this.tipFor !== mark || !mark.button.isConnected) return;
    this.tipQ.textContent = firstLine(messageText(mark.target), 200) || 'Your message';
    this.tipA.textContent = replyText(mark.target);
    const root = this.view.root.getBoundingClientRect();
    const r = mark.button.getBoundingClientRect();
    const x = Math.round(r.right - root.left + 8);
    this.tip.style.setProperty('--tip-room', `${Math.max(160, Math.round(root.width - x - 16))}px`);
    const hgt = this.tip.offsetHeight;
    const y = Math.round(Math.min(Math.max(8, r.top + r.height / 2 - root.top - hgt / 2), root.height - hgt - 8));
    this.tip.style.setProperty('--tip-x', `${x}px`);
    this.tip.style.setProperty('--tip-y', `${y}px`);
    this.tip.classList.add('on');
  }

  hideTip() {
    clearTimeout(this.tipTimer);
    this.tipFor = null;
    this.tip.classList.remove('on');
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.tipTimer);
    this.io.disconnect();
    this.finder?.disconnect();
    this.landing?.abort();
    this.finder = null;
    this.mo.disconnect();
    this.ro.disconnect();
    this.tip.remove();
  }

  /** Scroll so `el` sits a third of the way down the screen, and flash it so the eye finds it. */
  jumpTo(el) {
    const sc = this.view.scroller;
    const fold = el.closest('details.work:not([open])');
    if (fold) fold.open = true; // the step is inside a folded turn: show it
    this.view.stick = false;
    const off = () => el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
    sc.scrollTo({ top: Math.max(0, sc.scrollTop + off()), behavior: still() ? 'auto' : 'smooth' });
    // Messages on the way take their real heights as they come into view, so a long jump can stop short of the
    // turn. When the scroll ends, land on it exactly, unless the reader has taken over meanwhile.
    this.landing?.abort();
    const landing = (this.landing = new AbortController());
    const opts = { signal: landing.signal, passive: true };
    for (const ev of ['wheel', 'pointerdown', 'keydown', 'touchstart']) sc.addEventListener(ev, () => landing.abort(), opts);
    sc.addEventListener('scrollend', () => {
      landing.abort();
      const by = off();
      if (el.isConnected && Math.abs(by) > 8) sc.scrollTo({ top: Math.max(0, sc.scrollTop + by), behavior: 'auto' });
    }, opts);
    setTimeout(() => landing.abort(), 4000);
    el.classList.remove('tl-flash');
    void el.offsetWidth; // restart the flash if it is already playing
    el.classList.add('tl-flash');
    setTimeout(() => el.classList.remove('tl-flash'), 1400);
  }

  /** Jump to the previous (-1) or next (+1) message of yours, relative to what is on screen. */
  stepYou(dir) {
    this.view.finishFill?.(); // every message of yours must be in the page to step through them
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
