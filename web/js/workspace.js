// Task suggestions under the Home task box. A click puts the full text in the box, ready to edit and send.
import { h, icon } from './dom.js';

const RECIPES = [
  ['compass', 'Explore', 'Understand the codebase', 'Explain how this project is put together: entry points, main modules, how data flows, and where to start reading.'],
  ['wrench', 'Debug', 'Get to the root cause', 'Investigate this issue: [describe the issue]. Trace its root cause, propose the smallest fix, and verify the affected behavior.'],
  ['branch', 'Review', 'Check changes for regressions', 'Review my uncommitted changes for bugs, edge cases and regressions. Give concrete findings with file references. Do not change files.'],
  ['bolt', 'Build', 'Implement a feature', 'Implement this feature: [describe the feature]. Follow the project conventions, consider edge cases, and verify the result.'],
];
let recipesEl = null;
export function recipes(comp) {
  if (recipesEl?._comp === comp) return recipesEl;
  const feedback = h('span', { class: 'recipe-feedback', role: 'status', 'aria-live': 'polite' });
  let before = '', inserted = '';
  const undo = h('button', { class: 'brief-chip', type: 'button', hidden: true, onclick: () => {
    if (comp.value !== inserted) { feedback.textContent = 'Draft changed. Undo skipped to preserve your edits.'; undo.hidden = true; return; }
    comp.value = before; undo.hidden = true; comp.focus(); feedback.textContent = 'Starter undone';
  } }, icon('undo', 12), 'Undo starter');
  const cards = RECIPES.map(([glyph, title, desc, text]) => h('button', {
    class: 'ws-recipe', type: 'button', title: text, onclick: () => {
      before = comp.value;
      comp.value = comp.value.trim() ? `${comp.value.trimEnd()}\n\n${text}` : text;
      inserted = comp.value; undo.hidden = false;
      feedback.textContent = `${title} starter added to your draft`;
      comp.focus();
      const placeholder = /\[[^\]]+\]/.exec(text);
      if (placeholder) {
        const start = comp.value.lastIndexOf(text) + placeholder.index;
        comp.ta.setSelectionRange(start, start + placeholder[0].length);
      }
    },
  }, h('span', { class: 'recipe-top' }, icon(glyph, 17), icon('chevron-right', 14)), h('strong', null, title), h('span', { class: 'recipe-description' }, desc)));
  recipesEl = h('div', { class: 'workspace-starters' },
    h('div', { class: 'starter-heading' }, h('span', null, 'Task starters'), undo, h('span', null, 'Add a brief. Edit before sending.')),
    h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Task suggestions' }, cards),
    h('div', { class: 'brief-options', role: 'group', 'aria-label': 'Task constraints' }, h('span', null, 'Add a constraint'), ...[
      ['Smallest change', 'Keep the change as small as possible. Avoid unrelated refactoring.'],
      ['Explain first', 'Explain your approach before changing any files.'],
      ['Verify behavior', 'Verify the affected behavior and report what was checked.'],
    ].map(([label, text]) => h('button', { class: 'brief-chip', type: 'button', onclick: () => {
      if (!comp.value.includes(text)) comp.value = [comp.value.trimEnd(), text].filter(Boolean).join('\n\n');
      feedback.textContent = `${label} constraint added`; comp.focus();
    } }, icon('plus', 11), label))), feedback);
  recipesEl._comp = comp;
  return recipesEl;
}
