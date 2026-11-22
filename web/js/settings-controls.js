import { h } from './dom.js';

export const group = (title, note, ...rows) => h('section', { class: 'set-group' }, title ? h('h4', { class: 'set-sub' }, title) : null, note ? h('p', { class: 'set-note' }, note) : null, h('div', { class: 'set-card' }, ...rows));

export function pick(label, options, value, onPick) {
  const sel = h('select', { class: 'set-select', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  sel.addEventListener('change', () => onPick(sel.value, sel));
  return sel;
}

export function seg(label, options, value, onPick) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [v, l] of options) {
    wrap.append(h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), onclick: (e) => {
      for (const x of wrap.children) x.setAttribute('aria-checked', String(x === e.currentTarget));
      onPick(v);
    } }, l));
  }
  return wrap;
}
