// "How ORBIX works": the whole product on one short screen.
import { h, kbd } from './dom.js';
import { modal, btn } from './dialogs.js';

export function openHelp() {
  const step = (title, text) => h('li', null, h('strong', null, title), h('span', null, text));
  const m = modal({
    title: 'How ORBIX works',
    body: h('div', { class: 'help' },
      h('p', null, 'You describe a task. The agent reads your files, edits them and runs commands to do it, and shows every step.'),
      h('ol', { class: 'help-steps' },
        step('Connect a model', 'Add an API key (Anthropic, OpenAI, OpenRouter and more) or a local model (Ollama) in Settings → AI providers.'),
        step('Choose a project folder', 'The agent works only inside it. It can be on Windows (C:\\…) or in WSL (/home/…).'),
        step('Describe the task', 'For example: find why the login test fails and fix it.'),
        step('Approve changes', 'The agent asks before it edits a file or runs a command. Reading and searching don’t need your OK.'),
        step('Undo', 'Click Undo on an edit, or type /undo, to restore your files.')),
      h('div', { class: 'help-keys' }, h('span', null, kbd('Ctrl+K'), ' commands'), h('span', null, kbd('/'), ' slash commands'), h('span', null, kbd('@'), ' mention a file'), h('span', null, kbd('Alt+Enter'), ' queue a message'), h('span', null, kbd('Esc'), ' stop')),
      h('p', { class: 'set-note' }, 'Rules the agent always follows go in AGENTS.md at the project root.')),
    actions: [btn('Close', () => m.close(), 'primary')],
  });
  return m;
}
