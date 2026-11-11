// Task suggestions: under the Home task box, and in an empty session for the open project.
// A click puts the full text in the message box, ready to edit and send.
import { h } from './dom.js';

const T = {
  explain: ['Explain this project', 'Explain how this project is put together: entry points, main modules, how data flows, and where to start reading.'],
  bug: ['Find a bug', 'Investigate this issue: [describe the issue]. Trace its root cause, propose the smallest fix, and verify the affected behavior.'],
  review: ['Review my changes', 'Review my uncommitted changes for bugs, edge cases and regressions. Give concrete findings with file references. Do not change files.'],
  feature: ['Add a feature', 'Implement this feature: [describe the feature]. Follow the project conventions, consider edge cases, and verify the result.'],
  tests: ['Run the tests', 'Run this project’s tests. If any fail, find out why, propose the smallest fix, and run them again.'],
  readme: ['Write a README', 'Write a README for this project from its code: what it does, how to install and run it, and how the code is laid out.'],
  start: ['Start a project', 'Set up a new project in this folder: [describe what you want to build]. Keep the structure simple, add a README, and explain how to run it.'],
  plan: ['Plan the first steps', 'This folder is empty. Ask me what I want to build, then propose a short plan before writing any files.'],
};

const RECIPES = [T.explain, T.bug, T.review, T.feature];

/** Buttons that fill `comp` with a task. A task with a blank to fill in starts with that blank selected. */
function taskButtons(comp, tasks, cls) {
  return tasks.map(([label, text]) => h('button', { class: cls, type: 'button', title: text, onclick: () => {
    comp.value = comp.value.trim() ? `${comp.value.trimEnd()}\n\n${text}` : text;
    comp.focus();
    const gap = /\[[^\]]+\]/.exec(text);
    if (gap) {
      const start = comp.value.lastIndexOf(text) + gap.index;
      comp.ta.setSelectionRange(start, start + gap[0].length);
    }
  } }, label));
}

let recipesEl = null;
export function recipes(comp) {
  if (recipesEl?._comp === comp) return recipesEl;
  recipesEl = h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Task suggestions' }, taskButtons(comp, RECIPES, 'ws-recipe'));
  recipesEl._comp = comp;
  return recipesEl;
}

const BUILD = ['package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'makefile', 'cmakelists.txt', 'gemfile', 'composer.json', 'deno.json', 'mix.exs', 'pubspec.yaml'];
const README = /^readme(\.(md|markdown|txt|rst|adoc))?$/i;

/**
 * Four first tasks for a project, from what is in its folder (`entries`, from /api/fs/list) and whether it has
 * uncommitted changes (`changed`). An empty folder gets tasks for starting one.
 */
export function projectTasks(entries, { changed = false } = {}) {
  const names = entries.map((e) => e.name.toLowerCase());
  if (!names.filter((n) => n !== '.git').length) return [T.start, T.plan];
  const out = [T.explain];
  if (changed) out.push(T.review);
  if (names.some((n) => BUILD.includes(n) || n.endsWith('.csproj') || n.endsWith('.sln'))) out.push(T.tests);
  if (!names.some((n) => README.test(n))) out.push(T.readme);
  for (const t of [T.bug, T.feature]) if (out.length < 4) out.push(t);
  return out.slice(0, 4);
}

/** The suggestions row of an empty session. */
export function sessionTasks(comp, tasks) {
  return h('div', { class: 'ce-tasks', role: 'group', 'aria-label': 'Suggested first tasks' }, taskButtons(comp, tasks, 'ce-task'));
}
