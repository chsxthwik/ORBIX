// Settings → AI providers → "Models": the default fast model and plan model. Both are optional; empty means
// "use the model of the session". Each choice is checked against the provider's own model list before it is saved.
import { h, toast, replace } from './dom.js';
import { api } from './api.js';
import { loadEngine } from './store.js';
import { row, btn } from './dialogs.js';

const SAVED = 'pv-save-hidden';

const ROLES = [
  ['fast', 'Fast model', 'Used for chat titles, summaries of long chats (/compact and automatic) and helper agents. A small, cheap model is a good choice.'],
  ['plan', 'Plan model', 'Used while plan mode is on (/plan). A stronger model is a good choice.'],
];

export function renderModelRoles(root, engine) {
  if (!engine.providers.some((p) => p.configured)) return replace(root);
  const dl = h('datalist', { id: 'models-all' });
  const rows = ROLES.map(([role, label, hint]) => {
    const input = h('input', { type: 'text', class: 'role-in', list: 'models-all', value: engine.models?.[role] || '', placeholder: 'Session model', spellcheck: 'false', autocomplete: 'off', 'aria-label': label });
    const save = btn('Save', async () => {
      save.disabled = true;
      try {
        await api.post('/api/engine/models', { [role]: input.value.trim() });
        await loadEngine();
        toast(input.value.trim() ? `${label}: saved` : `${label}: the session’s model is used`, 'ok', 2500);
        saved = input.value.trim();
        sync();
      } catch (e) {
        toast(e.message, 'error', 8000);
      }
      save.disabled = false;
    }, 'sm');
    let saved = input.value.trim();
    const sync = () => save.classList.toggle(SAVED, input.value.trim() === saved);
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value.trim() !== saved && save.click());
    save.classList.add(SAVED);
    return row(label, h('div', { class: 'role-ctl' }, input, save), hint);
  });
  replace(root, h('p', { class: 'set-note' }, 'Leave a box empty to use the session’s model. In a session, /model fast and /model plan change them for that session only.'), h('div', { class: 'set-card' }, rows), dl);
  api.get('/api/engine/models').then((r) => {
    replace(dl, r.models.map((m) => h('option', { value: `${m.provider}/${m.id}` }, `${m.providerName}: ${m.name}`)));
    if (r.errors?.length) toast(r.errors[0], 'info', 5000);
  }).catch(() => {});
}
