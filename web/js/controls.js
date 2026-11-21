// Two controls of the message box, shared by Home and every conversation: "+" (add context: files, a mention, a
// command) and the permission chip (how much the agent may do without asking: Ask first, Auto edits, Turbo).
import { h, icon, iconBtn, toast } from './dom.js';
import { S, loadEngine, emit } from './store.js';
import { api } from './api.js';
import { popMenu, confirmDialog } from './dialogs.js';

/** Type `ch` at the caret, as if typed, so the box opens its pop-up (@ files, / commands). */
function typeAtCaret(ta, ch) {
  ta.focus();
  const a = ta.selectionStart ?? ta.value.length;
  const b = ta.selectionEnd ?? a;
  const before = ta.value.slice(0, a);
  const lead = ch === '/' ? (before.trim() ? '\n' : '') : before && !/\s$/.test(before) ? ' ' : '';
  ta.setRangeText(lead + ch, a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The "+" button: attach files, mention a file or folder, run a command. */
export function addContext(composer) {
  const b = iconBtn('plus', 'Add context', () => popMenu(b, [
    { label: 'Images or text files…', run: () => composer.openFilePicker() },
    { label: 'Mention a file or folder', hint: '@', run: () => typeAtCaret(composer.ta, '@') },
    { label: 'Commands', hint: '/', run: () => typeAtCaret(composer.ta, '/') },
  ], { minWidth: 230 }), 'c-add');
  b.setAttribute('aria-haspopup', 'menu');
  return b;
}

const MODES = [
  ['ask', 'Ask first', 'shield', 'Every edit and command waits for your OK.'],
  ['edits', 'Auto edits', 'pencil', 'Edits run (each can be undone); commands ask.'],
  ['auto', 'Turbo', 'bolt', 'Edits and commands run; destructive ones still ask.'],
];

/** The permission chip: one setting for every conversation (Settings → General → Permission preset is the same choice). */
export function permissionChip() {
  const btn = h('button', { class: 'cbtn c-perm', type: 'button', 'aria-haspopup': 'menu' });
  const set = async (mode) => {
    if (mode === (S.engine?.approvals || 'ask')) return;
    if (mode === 'auto' && !(await confirmDialog('Turn on Turbo', 'The agent will edit files and run commands without asking, also outside the project folder. Edits can be undone; commands cannot. Destructive commands (deleting folders, pushing, publishing) still ask.', { ok: 'Turn on Turbo', danger: true }))) return;
    try {
      await api.post('/api/engine/settings', { approvals: mode });
      await loadEngine();
      emit('engine');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  btn.addEventListener('click', () => {
    const cur = S.engine?.approvals || 'ask';
    popMenu(btn, [{ header: 'Permissions' }, ...MODES.map(([k, label, ic, desc]) => ({ icon: ic, label, desc, sel: cur === k, run: () => set(k) }))], { align: 'end', minWidth: 300 });
  });
  let shownMode;
  const update = (hidden = false) => {
    const mode = MODES.find((m) => m[0] === (S.engine?.approvals || 'ask')) || MODES[0];
    btn.hidden = hidden;
    if (shownMode === mode[0]) return;
    shownMode = mode[0];
    btn.classList.toggle('risky', mode[0] === 'auto');
    btn.title = `${mode[1]}: ${mode[3]} Click to change.`;
    btn.replaceChildren(icon(mode[2], 13), h('span', null, mode[1]), icon('chevron-down', 12, 'cbtn-chev'));
  };
  update();
  return { el: btn, update };
}
