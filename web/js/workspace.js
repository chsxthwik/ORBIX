// Task suggestions under the Home task box. A click puts the full text in the box, ready to edit and send.
import { h } from './dom.js';

const RECIPES = [
  ['Explain this project', 'Explain how this project is put together: entry points, main modules, how data flows, and where to start reading.'],
  ['Find a bug', 'Investigate this issue: [describe the issue]. Trace its root cause, propose the smallest fix, and verify the affected behavior.'],
  ['Review my changes', 'Review my uncommitted changes for bugs, edge cases and regressions. Give concrete findings with file references. Do not change files.'],
  ['Add a feature', 'Implement this feature: [describe the feature]. Follow the project conventions, consider edge cases, and verify the result.'],
];
let recipesEl = null;
export function recipes(comp) {
  if (recipesEl?._comp === comp) return recipesEl;
  recipesEl = h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Task suggestions' }, RECIPES.map(([label, text]) => h('button', { class: 'ws-recipe', type: 'button', title: text, onclick: () => {
    comp.value = comp.value.trim() ? `${comp.value.trimEnd()}\n\n${text}` : text;
    comp.focus();
    // A suggestion with a blank to fill in starts with that blank selected.
    const gap = /\[[^\]]+\]/.exec(text);
    if (gap) {
      const start = comp.value.lastIndexOf(text) + gap.index;
      comp.ta.setSelectionRange(start, start + gap[0].length);
    }
  } }, label)));
  recipesEl._comp = comp;
  return recipesEl;
}
