// Select text in a conversation to ask about it: a small bar above the selection puts it in the message box
// as a Markdown quote, or copies it.
import { h, icon, copyText } from './dom.js';

export function quoteOnSelect(view) {
  const stop = new AbortController();
  const opts = { signal: stop.signal };
  let text = '';
  const keep = (e) => e.preventDefault(); // a click on the bar must not clear the selection first
  const askBtn = h('button', { class: 'qsel-b', type: 'button', onmousedown: keep, onclick: () => ask() }, icon('message', 13), 'Ask about this');
  const copyBtn = h('button', { class: 'qsel-b', type: 'button', onmousedown: keep, onclick: () => copy() }, icon('copy', 13), 'Copy');
  const bar = h('div', { class: 'qsel', role: 'toolbar', 'aria-label': 'Selected text', hidden: true }, askBtn, copyBtn);
  view.root.append(bar);

  const hide = () => {
    bar.hidden = true;
    text = '';
  };
  const place = () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    const r = sel.getRangeAt(0);
    if (!view.tin.contains(r.commonAncestorContainer) || r.commonAncestorContainer.closest?.('textarea, input')) return hide();
    const t = sel.toString().trim().replace(/^[.,;:!?)\]]+\s*/, ''); // a drag that started just after a word
    if (t.length < 2) return hide();
    text = t;
    askBtn.hidden = !!view.tab.dead;
    const rects = r.getClientRects();
    const first = rects[0] || r.getBoundingClientRect();
    const host = view.root.getBoundingClientRect();
    const frame = view.scroller.getBoundingClientRect();
    bar.hidden = false;
    const w = bar.offsetWidth;
    const bh = bar.offsetHeight;
    const x = Math.max(8, Math.min(host.width - w - 8, first.left + first.width / 2 - host.left - w / 2));
    // Above the first line; below the last one when the top is hidden under the session bar.
    let y = first.top - host.top - bh - 8;
    if (first.top - bh - 8 < frame.top) {
      const last = rects[rects.length - 1] || first;
      y = Math.min(frame.bottom - host.top - bh - 8, last.bottom - host.top + 8);
    }
    bar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  function ask() {
    if (!text || view.tab.dead) return;
    const c = view.composer;
    const quote = text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n') + '\n\n';
    const cur = c.value.replace(/\s+$/, '');
    c.value = (cur ? cur + '\n\n' : '') + quote;
    getSelection().removeAllRanges();
    hide();
    c.focus();
    c.ta.setSelectionRange(c.value.length, c.value.length);
  }
  async function copy() {
    if (!text) return;
    await copyText(text);
    getSelection().removeAllRanges();
    hide();
  }

  view.tin.addEventListener('mouseup', () => setTimeout(place), opts);
  view.tin.addEventListener('keyup', (e) => e.shiftKey && place(), opts);
  view.tin.addEventListener('mousedown', (e) => !bar.contains(e.target) && hide(), opts);
  view.scroller.addEventListener('scroll', () => !bar.hidden && place(), { ...opts, passive: true });
  document.addEventListener('selectionchange', () => !bar.hidden && getSelection()?.isCollapsed && hide(), opts);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !bar.hidden && (hide(), e.stopPropagation()), { ...opts, capture: true });
  return { destroy: () => (stop.abort(), bar.remove()) };
}
