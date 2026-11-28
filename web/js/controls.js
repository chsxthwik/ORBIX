// Controls of the message box, shared by Home and every conversation: "+" (modes, images and files, commands,
// context, a shell command), the mode pill, the model button ("Provider / Model"), the reasoning level, and the permission chip (how much the
// agent may do without asking: Supervised, Auto edits, Guarded, Full access).
import { h, icon, iconBtn, toast, kbd, fmtTokens } from './dom.js';
import { S, loadEngine, emit } from './store.js';
import { api } from './api.js';
import { popover, confirmDialog, thinkingName, LEVEL_NOTE } from './dialogs.js';
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

// Conversation modes. Agent is the default and has no pill; the others change what the agent may do (see
// src/engine/proc.mjs _setMode): Plan and Ask cannot edit files, Debug works root cause first.
const SVG = 'http://www.w3.org/2000/svg';
const MODE_PATHS = {
  plan: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  ask: 'M21 12a9 9 0 0 1-13.5 7.8L3 21l1.2-4.5A9 9 0 1 1 21 12ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.1M12 17h.01',
  debug: 'M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6ZM12 20v-9M6.5 9.5C4.6 9.3 3 7.8 3 6M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 6c0 1.8-1.6 3.3-3.5 3.5M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4',
};
export const CHAT_MODES = [
  { id: 'plan', label: 'Plan', desc: 'Generate an implementation plan' },
  { id: 'ask', label: 'Ask', desc: 'Answer questions without making edits' },
  { id: 'debug', label: 'Debug', desc: 'Find the root cause of an issue' },
];
export const modeName = (id) => CHAT_MODES.find((m) => m.id === id)?.label || 'Agent';

/** A mode's icon, in the mode's colour (CSS: .mode-ic[data-mode]). */
export function modeIcon(id, size = 14) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'mode-ic', 'data-mode': id })) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', MODE_PATHS[id] || '');
  svg.append(p);
  return svg;
}

/** Fuzzy-ish filter for the "+" menu: every word of the query appears in the label or the description. */
const matches = (q, ...texts) => {
  const hay = texts.join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/**
 * The "+" button: a searchable menu with the conversation modes (Plan, Ask, Debug), then attach files, a slash
 * command, a file or folder as context, or a shell command. `mode`: { get() → 'agent'|'plan'|'ask'|'debug',
 * set(id), available() → bool }; without it the menu has no modes. Picking the mode in use turns it off.
 */
export function addContext(composer, mode = null) {
  const b = iconBtn('plus', 'Add to the message', () => open(), 'c-add');
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-expanded', 'false');
  let pop = null;
  const open = () => {
    if (pop) return pop.close();
    const listId = `am-${Math.random().toString(36).slice(2, 8)}`;
    const q = h('input', { class: 'am-q', type: 'text', placeholder: 'Search modes, context, files…', 'aria-label': 'Search modes, context, files', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': listId, 'aria-autocomplete': 'list' });
    const list = h('div', { class: 'am-list', id: listId, role: 'listbox', 'aria-label': 'Add to the message' });
    const current = mode?.get?.() || 'agent';
    const rows = [
      ...(mode && mode.available() ? CHAT_MODES.map((m) => ({ kind: 'mode', id: m.id, label: m.label, desc: m.desc, on: current === m.id, run: () => mode.set(current === m.id ? 'agent' : m.id) })) : []),
      { kind: 'act', ic: 'paperclip', label: 'Attach files', desc: 'Images and text files', run: () => composer.openFilePicker() },
      { kind: 'act', ic: 'command', label: 'Commands', hint: '/', desc: 'Slash commands and skills', run: () => typeAtCaret(composer.ta, '/') },
      { kind: 'act', ic: 'at', label: 'Context', hint: '@', desc: 'Files and folders', run: () => typeAtCaret(composer.ta, '@') },
      { kind: 'act', ic: 'terminal', label: 'Shell', hint: '!', desc: 'Run a command in the Terminal', run: () => typeAtCaret(composer.ta, '!') },
    ];
    let shown = [];
    let sel = 0;
    const pick = (r) => {
      pop.close(false);
      if (r.kind === 'mode') composer.focus?.();
      r.run();
    };
    const paint = () => {
      for (const [i, el] of [...list.querySelectorAll('.am-it')].entries()) {
        const on = i === sel;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', String(on));
        if (on) {
          q.setAttribute('aria-activedescendant', el.id);
          el.scrollIntoView({ block: 'nearest' });
        }
      }
    };
    const draw = () => {
      shown = rows.filter((r) => matches(q.value, r.label, r.desc, r.hint || ''));
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      const items = [];
      shown.forEach((r, i) => {
        if (i && r.kind !== shown[i - 1].kind) items.push(h('div', { class: 'am-sep', role: 'separator' }));
        items.push(h('div', { class: 'am-it' + (r.on ? ' on' : ''), id: `${listId}-${i}`, role: 'option', 'data-kind': r.kind, 'aria-selected': 'false', onmousedown: (e) => e.preventDefault(), onclick: () => pick(r), onmousemove: () => { if (sel !== i) { sel = i; paint(); } } },
          r.kind === 'mode' ? h('span', { class: 'am-ic', 'data-mode': r.id }, modeIcon(r.id, 14)) : h('span', { class: 'am-ic' }, icon(r.ic, 14)),
          h('span', { class: 'am-l' }, h('span', { class: 'am-t' }, r.label), h('span', { class: 'am-d ell' }, r.desc)),
          r.on ? icon('check', 14, 'am-on') : r.hint ? kbd(r.hint) : null));
      });
      if (!shown.length) items.push(h('div', { class: 'am-empty' }, 'No matches'));
      list.replaceChildren(...items);
      if (!shown.length) q.removeAttribute('aria-activedescendant');
      paint();
      pop?.el._place?.();
    };
    q.addEventListener('input', () => { sel = 0; draw(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (shown.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        paint();
      } else if (e.key === 'Home' || e.key === 'End') {
        if (q.value) return;
        e.preventDefault();
        sel = e.key === 'Home' ? 0 : shown.length - 1;
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown[sel]) pick(shown[sel]);
      } else if (e.key === 'Tab') pop.close(false);
    });
    pop = popover(b, [h('div', { class: 'am-top' }, icon('search', 14), q), list], {
      align: 'start', cls: 'am-pop', label: 'Add to the message',
      onClose: () => {
        pop = null;
        b.setAttribute('aria-expanded', 'false');
      },
    });
    b.setAttribute('aria-expanded', 'true');
    draw();
    q.focus({ preventScroll: true });
  };
  return b;
}

/**
 * The mode in use, as a small pill in the message box's row ("Plan ×"). Hidden for Agent. `onClear()` goes back
 * to Agent. `update(id)` redraws it.
 */
export function modePill(onClear) {
  const label = h('span', { class: 'c-modepill-l' });
  const x = h('button', { class: 'c-modepill-x', type: 'button', onclick: () => onClear() }, icon('x', 12));
  const el = h('span', { class: 'c-modepill', hidden: true }, label, x);
  let shown;
  const update = (id = 'agent', disabled = false) => {
    const on = id && id !== 'agent' && CHAT_MODES.some((m) => m.id === id);
    el.hidden = !on;
    x.disabled = disabled;
    if (!on || shown === id) return;
    shown = id;
    const m = CHAT_MODES.find((c) => c.id === id);
    el.dataset.mode = id;
    el.title = `${m.label} mode: ${m.desc.toLowerCase()}`;
    label.replaceChildren(modeIcon(id, 13), h('span', null, m.label));
    x.title = `Leave ${m.label} mode`;
    x.setAttribute('aria-label', `Leave ${m.label} mode`);
  };
  return { el, update };
}

/** The model button and the reasoning level read as one chip: "Opus 5.5 | Medium". */
export function modelGroup(modelBtn, effortEl) {
  return h('span', { class: 'c-model-grp' }, modelBtn, effortEl);
}

/**
 * The keys under the message box: what Enter does right now (send, or steer / queue while the agent works), how to add
 * a line, and a rough size once the text gets long. `update({ busy, chars })` redraws it only when something changed.
 */
export function keyHints() {
  const el = h('div', { class: 'c-keys', 'aria-hidden': 'true' });
  let sig = '';
  const update = ({ busy = false, chars = 0 } = {}) => {
    const ctrl = S.ui?.sendKey === 'ctrl';
    const queue = S.ui?.whileBusy === 'queue';
    const size = chars >= 400 ? `~${fmtTokens(Math.round(chars / 4))} tokens` : '';
    const next = JSON.stringify([ctrl, queue, busy, size]);
    if (next === sig) return;
    sig = next;
    const send = ctrl ? 'Ctrl+Enter' : 'Enter';
    const keys = busy
      ? [[send, queue ? 'queue' : 'steer'], ['Alt+Enter', queue ? 'steer' : 'queue'], ['Esc', 'stop']]
      : [[send, 'send'], [ctrl ? 'Enter' : 'Shift+Enter', 'new line']];
    el.replaceChildren(
      size ? h('span', { class: 'c-size num' }, size) : '',
      ...keys.map(([k, what]) => h('span', { class: 'c-key' }, kbd(k), h('span', null, what))),
    );
  };
  update();
  return { el, update };
}

/** What the model button shows: the provider (or agent) dimmed, then the model: "Claude Code / Opus 5.5". */
export function modelLabel(m) {
  const pv = m ? S.engine?.providers?.find((p) => p.id === m.provider)?.name || m.provider || '' : '';
  const name = m ? m.name || m.id : 'Default model';
  return [modelMark(m?.provider, m?.id, 15, 'pv-mark'), pv ? h('span', { class: 'c-pv ell' }, pv) : null, pv ? h('span', { class: 'c-sl', 'aria-hidden': 'true' }, '/') : null, h('span', { class: 'c-mn ell' }, name), icon('chevron-down', 12, 'cbtn-chev')].filter(Boolean);
}

/**
 * The dot field behind the reasoning slider: a grid of dots up to the thumb, lit by slow drifting waves, brighter
 * and busier the higher the level. Drawn only while the panel is open; reduced motion draws one still frame.
 */
function dotField(canvas, getFill) {
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('no-motion');
  const color = getComputedStyle(canvas).color || '#3df28c';
  let raf = 0;
  const t0 = performance.now();
  const frame = (now) => {
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(hgt * dpr)) canvas.height = Math.round(hgt * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = color;
    const { x: fillTo, energy } = getFill();
    const t = (now - t0) / 1000;
    const step = 3.5;
    for (let x = 2; x < w; x += step) {
      const inFill = x <= fillTo;
      for (let y = 2; y < hgt; y += step) {
        // Two slow waves crossing, a third one faster as the level rises.
        const wave = Math.sin(x * 0.045 - t * (0.8 + energy)) + Math.sin(y * 0.22 + x * 0.018 + t * 0.6) + Math.sin((x + y) * 0.03 - t * 1.7 * energy);
        const b = Math.max(0, Math.min(1, 0.5 + wave / 4));
        const a = inFill ? 0.3 + b * (0.5 + energy * 0.2) : 0.06 + b * 0.06;
        const sz = inFill ? (b > 0.78 ? 2.4 : 1.8) : 1.2;
        ctx.globalAlpha = Math.min(1, a);
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    ctx.globalAlpha = 1;
    if (!still) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

/**
 * The reasoning level as its own control ("Medium ⌄"), for a model that has levels. It opens a slider over a live dot
 * field: Off on the left, the model's highest level on the right, the default marked. `onPick(level)` applies one;
 * `update(levels, level, { model, def })` redraws the chip (no levels: hidden).
 */
export function effortChip(onPick) {
  let levels = [];
  let level = '';
  let info = {};
  const btn = h('button', { class: 'cbtn c-effort', type: 'button', 'aria-haspopup': 'dialog', hidden: true, onclick: () => open() });
  const open = () => {
    if (!levels.length) return;
    if (document.querySelector('.rs-pop:not(.leaving)')) return document.querySelector('.rs-pop')._close();
    let at = Math.max(0, levels.indexOf(level || info.def || levels[0]));
    const last = levels.length - 1;
    const name = h('b', { class: 'rs-name' });
    const note = h('p', { class: 'rs-note' });
    const field = h('canvas', { class: 'rs-field', 'aria-hidden': 'true' });
    const thumb = h('span', { class: 'rs-thumb', 'aria-hidden': 'true' });
    const track = h('div', { class: 'rs-track', role: 'slider', tabindex: '0', 'aria-label': 'Reasoning level', 'aria-valuemin': '0', 'aria-valuemax': String(last) }, field, thumb);
    const ticks = h('div', { class: 'rs-ticks' }, levels.map((l, i) => {
      const b = h('button', { type: 'button', class: 'rs-tick', onclick: () => (set(i), commit()) }, thinkingName(l), l === info.def ? h('small', null, ' · default') : null);
      b.style.setProperty('--x', last ? `${(i / last) * 100}%` : '50%');
      return b;
    }));
    const pos = () => (last ? at / last : 0.5);
    const paint = () => {
      const l = levels[at];
      name.textContent = thinkingName(l);
      note.textContent = LEVEL_NOTE[l] || '';
      track.setAttribute('aria-valuenow', String(at));
      track.setAttribute('aria-valuetext', thinkingName(l));
      thumb.style.left = `calc(20px + (100% - 40px) * ${pos().toFixed(4)})`;
      for (const [i, t] of [...ticks.children].entries()) t.classList.toggle('on', i === at);
    };
    const set = (i) => {
      at = Math.max(0, Math.min(last, i));
      paint();
    };
    const commit = () => {
      if (levels[at] !== level) onPick(levels[at]);
    };
    const fromX = (cx) => {
      const r = track.getBoundingClientRect();
      set(Math.round(((cx - r.left - 20) / Math.max(1, r.width - 40)) * last));
    };
    track.addEventListener('pointerdown', (e) => {
      track.setPointerCapture(e.pointerId);
      track.classList.add('drag');
      fromX(e.clientX);
    });
    track.addEventListener('pointermove', (e) => track.hasPointerCapture(e.pointerId) && fromX(e.clientX));
    track.addEventListener('pointerup', (e) => {
      track.releasePointerCapture(e.pointerId);
      track.classList.remove('drag');
      commit();
    });
    track.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (d) return e.preventDefault(), set(at + d), commit();
      if (e.key === 'Home' || e.key === 'End') return e.preventDefault(), set(e.key === 'Home' ? 0 : last), commit();
      // 1…9 jump straight to a level; Enter is done.
      if (/^[1-9]$/.test(e.key) && +e.key - 1 <= last) return e.preventDefault(), set(+e.key - 1), commit();
      if (e.key === 'Enter') return e.preventDefault(), pop.close();
    });
    const scale = h('div', { class: 'rs-scale', 'aria-hidden': 'true' }, h('span', null, icon('bolt', 12), 'Faster'), h('span', null, 'Deeper', icon('brain', 12)));
    const keys = h('div', { class: 'rs-keys', 'aria-hidden': 'true' }, h('span', null, kbd('←→'), 'adjust'), h('span', null, kbd(`1–${Math.min(9, last + 1)}`), 'jump'), h('span', null, kbd('Enter'), 'done'));
    const pop = popover(btn, [
      h('div', { class: 'rs-head' }, h('span', { class: 'rs-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), name),
      info.model ? h('div', { class: 'rs-model ell' }, info.model) : null,
      scale, track, ticks, note, keys,
    ].filter(Boolean), { align: 'start', cls: 'rs-pop', label: 'Reasoning' });
    paint();
    const stop = dotField(field, () => ({ x: 20 + pos() * (field.clientWidth - 40), energy: last ? at / last : 0.5 }));
    new MutationObserver((_, mo) => {
      if (pop.el.isConnected && !pop.el.classList.contains('leaving')) return;
      mo.disconnect();
      stop();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    track.focus({ preventScroll: true });
  };
  const update = (lv, at, meta = {}) => {
    levels = lv || [];
    level = at || '';
    info = meta || {};
    btn.hidden = !levels.length;
    if (!levels.length) return;
    // No level chosen yet (Home): the model's own default.
    const name = level ? thinkingName(level) : 'Default';
    btn.title = `Reasoning: ${name}`;
    // Settings → Appearance → Reasoning level: the name, or bars that fill up with the level.
    const real = levels.filter((l) => l !== 'off');
    const pos = real.indexOf(level);
    const bars = S.ui.effortDisplay === 'bars' && level ? h('span', { class: 'c-bars', 'aria-hidden': 'true' }, real.map((_, i) => {
      const b = h('i', { class: i <= pos ? 'on' : '' });
      b.style.height = `${4 + Math.round((8 * (i + 1)) / real.length)}px`;
      return b;
    })) : null;
    btn.setAttribute('aria-label', `Reasoning: ${name}`);
    btn.replaceChildren(...[bars || h('span', null, name), icon('chevron-down', 12, 'cbtn-chev')]);
    btn.dataset.level = level || 'default';
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
    // Full access wears a small warning triangle; the chip itself stays neutral.
    btn.replaceChildren(icon(mode[0] === 'auto' ? 'alert' : mode[2], 13), h('span', null, mode[1]), icon('chevron-down', 12, 'cbtn-chev'));
  };
  update();
  return { el: btn, update };
}
