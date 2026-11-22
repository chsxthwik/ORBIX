// Controls of the message box, shared by Home and every conversation: "+" (images and files, commands, context, a
// shell command), the model button ("Provider / Model"), the reasoning level, and the permission chip (how much the
// agent may do without asking: Supervised, Auto edits, Guarded, Full access).
import { h, icon, iconBtn, toast } from './dom.js';
import { S, loadEngine, emit } from './store.js';
import { api } from './api.js';
import { popMenu, popover, confirmDialog, thinkingName } from './dialogs.js';
import { modelMark } from './brands.js';

/** Type `ch` at the caret, as if typed, so the box opens its pop-up (@ files, / commands). `!` starts the line. */
function typeAtCaret(ta, ch) {
  ta.focus();
  if (ch === '!') {
    if (!ta.value.startsWith('!')) ta.value = '!' + ta.value;
    ta.setSelectionRange(1, 1);
    return ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const a = ta.selectionStart ?? ta.value.length;
  const b = ta.selectionEnd ?? a;
  const before = ta.value.slice(0, a);
  const lead = ch === '/' ? (before.trim() ? '\n' : '') : before && !/\s$/.test(before) ? ' ' : '';
  ta.setRangeText(lead + ch, a, b, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The "+" button: attach images and files, a slash command, a file or folder as context, or a shell command. */
export function addContext(composer) {
  const b = iconBtn('plus', 'Add to the message', () => popMenu(b, [
    { icon: 'paperclip', label: 'Images and files', run: () => composer.openFilePicker() },
    '-',
    { icon: 'command', label: 'Commands', hint: '/', run: () => typeAtCaret(composer.ta, '/') },
    { icon: 'at', label: 'Context', hint: '@', run: () => typeAtCaret(composer.ta, '@') },
    { icon: 'terminal', label: 'Shell command', hint: '!', run: () => typeAtCaret(composer.ta, '!') },
  ], { minWidth: 220 }), 'c-add');
  b.setAttribute('aria-haspopup', 'menu');
  return b;
}

/** What the model button shows: the provider (or agent) dimmed, then the model: "Claude Code / Opus 5.5". */
export function modelLabel(m) {
  const pv = m ? S.engine?.providers?.find((p) => p.id === m.provider)?.name || m.provider || '' : '';
  const name = m ? m.name || m.id : 'Default model';
  return [modelMark(m?.provider, m?.id, 15, 'pv-mark'), pv ? h('span', { class: 'c-pv ell' }, pv) : null, pv ? h('span', { class: 'c-sl', 'aria-hidden': 'true' }, '/') : null, h('span', { class: 'c-mn ell' }, name), icon('chevron-down', 12, 'cbtn-chev')].filter(Boolean);
}

/**
 * The reasoning level as its own small menu ("Medium ⌄"), for a model that has levels. `onPick(level)` applies one;
 * `update(levels, level)` redraws it (no levels: hidden).
 */
export function effortChip(onPick) {
  let levels = [];
  let level = '';
  const btn = h('button', { class: 'cbtn c-effort', type: 'button', 'aria-haspopup': 'menu', hidden: true, onclick: () => popMenu(btn, [{ header: 'Reasoning' }, ...levels.map((l) => ({ label: thinkingName(l), sel: l === level, run: () => onPick(l) }))], { minWidth: 170 }) });
  const update = (lv, at) => {
    levels = lv || [];
    level = at || '';
    btn.hidden = !levels.length;
    if (!levels.length) return;
    // No level chosen yet (Home): the model's own default.
    const name = level ? thinkingName(level) : 'Default';
    btn.title = `Reasoning: ${name}`;
    btn.replaceChildren(h('span', null, name), icon('chevron-down', 12, 'cbtn-chev'));
  };
  return { el: btn, update };
}

const MODES = [
  ['ask', 'Supervised', 'lock', 'Ask before commands and file changes.'],
  ['edits', 'Auto edits', 'pencil', 'File changes run without asking (each can be undone); commands ask.'],
  ['safe', 'Guarded', 'shield-check', 'File changes and read-only commands run; other commands ask.'],
  ['auto', 'Full access', 'shield-off', 'Allow commands and edits without prompts. Destructive ones still ask.'],
];

/**
 * The permission chip: one setting for every conversation (Settings → Preferences → Permissions is the same choice).
 * It opens a panel with the three modes as one segmented row and what the chosen one allows.
 */
export function permissionChip() {
  const btn = h('button', { class: 'cbtn c-perm', type: 'button', 'aria-haspopup': 'dialog' });
  const set = async (mode) => {
    if (mode === (S.engine?.approvals || 'ask')) return true;
    if (mode === 'auto' && !(await confirmDialog('Give full access', 'The agent will edit files and run commands without asking, also outside the project folder. Edits can be undone; commands cannot. Destructive commands (deleting folders, pushing, publishing) still ask.', { ok: 'Give full access', danger: true }))) return false;
    try {
      await api.post('/api/engine/settings', { approvals: mode });
      await loadEngine();
      emit('engine');
      return true;
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };
  btn.addEventListener('click', () => {
    if (document.querySelector('.perm-pop:not(.leaving)')) return document.querySelector('.perm-pop')._close();
    const title = h('b', { class: 'perm-t' });
    const desc = h('span', { class: 'perm-d' });
    const seg = h('div', { class: 'perm-seg', role: 'radiogroup', 'aria-label': 'Permissions' });
    const paint = (k) => {
      const mode = MODES.find((m) => m[0] === k) || MODES[0];
      title.textContent = mode[1];
      desc.textContent = mode[3];
      for (const b of seg.children) {
        const on = b.dataset.k === k;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };
    for (const [k, label, ic] of MODES) {
      seg.append(h('button', { class: 'perm-opt' + (k === 'auto' ? ' risky' : ''), type: 'button', role: 'radio', 'data-k': k, title: label, 'aria-label': label, onmouseenter: () => paint(k), onmouseleave: () => paint(S.engine?.approvals || 'ask'), onfocus: () => paint(k), onclick: async () => {
        if (await set(k)) pop.close();
      } }, icon(ic, 15)));
    }
    seg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const opts = [...seg.children];
      const i = opts.indexOf(document.activeElement);
      opts[(i + (e.key === 'ArrowRight' ? 1 : -1) + opts.length) % opts.length].focus();
    });
    const pop = popover(btn, [h('div', { class: 'perm-h' }, 'Permissions'), seg, h('div', { class: 'perm-info' }, title, desc)], { align: 'end', cls: 'perm-pop', label: 'Permissions' });
    paint(S.engine?.approvals || 'ask');
    seg.querySelector('.on')?.focus({ preventScroll: true });
  });
  let shownMode;
  const update = (hidden = false) => {
    const mode = MODES.find((m) => m[0] === (S.engine?.approvals || 'ask')) || MODES[0];
    btn.hidden = hidden;
    if (shownMode === mode[0]) return;
    shownMode = mode[0];
    btn.classList.toggle('risky', mode[0] === 'auto');
    btn.title = `Permissions: ${mode[1]}. ${mode[3]}`;
    btn.replaceChildren(icon(mode[2], 13), h('span', null, mode[1]), icon('chevron-down', 12, 'cbtn-chev'));
  };
  update();
  return { el: btn, update };
}
