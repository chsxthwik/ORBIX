// Settings → "OMP CLI" (only when the optional OMP CLI is installed): sign-in, where OMP runs, OMP's own settings.
import { h, icon, replace, toast, debounce, skeleton } from './dom.js';
import { api } from './api.js';
import { S, loadEnv, loadSessions } from './store.js';
import { btn, row, toggle } from './dialogs.js';
import { providersView } from './providers.js';

export function renderOmpSettings(el, sub, setSub) {
  const subs = [['signin', 'Sign-in'], ['backend', 'Where OMP runs'], ['settings', 'OMP settings']];
  const body = h('div', { class: 'stack' });
  el.append(h('div', { class: 'seg seg-sub', role: 'tablist' }, subs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === sub), 'aria-checked': String(k === sub), onclick: () => setSub(k) }, l))), body);
  ({ signin: providersView, backend: whereOmpRuns, settings: ompConfig })[sub](body);
}

async function whereOmpRuns(el) {
  const b = S.env.backend;
  const kind = h('select', { 'aria-label': 'Run OMP in' }, [['wsl', 'WSL (Linux)'], ['native', 'Windows']].map(([v, l]) => h('option', { value: v, selected: b.kind === v ? true : null }, l)));
  const distro = h('select', { 'aria-label': 'WSL distribution' });
  const omp = h('input', { type: 'text', class: 'mono', value: b.ompPath || '', placeholder: 'Detect automatically', spellcheck: 'false', 'aria-label': 'OMP executable path' });
  const status = h('div');
  const showStatus = (bb) => replace(status, bb.resolvedOmp ? h('div', { class: 'callout ok' }, icon('check', 14), h('span', null, `OMP ${bb.ompVersion || ''} at `, h('code', null, bb.resolvedOmp))) : h('div', { class: 'callout bad' }, icon('alert', 14), h('span', null, bb.error || (bb.kind === 'wsl' ? `OMP not found in WSL distribution "${bb.distro}".` : 'OMP not found on the Windows PATH.'))));
  showStatus(b);
  try {
    const env = await api.get('/api/env');
    replace(distro, (env.distros.length ? env.distros : [b.distro || '']).map((d) => h('option', { value: d, selected: (b.distro || env.defaultDistro) === d ? true : null }, d || '(none)')));
  } catch {}
  const save = async () => {
    try {
      const r = await api.post('/api/backend', { kind: kind.value, distro: distro.value, ompPath: omp.value.trim() });
      await loadEnv();
      showStatus(r.backend);
      toast('Saved. New sessions use it.', 'ok');
      loadSessions();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  el.append(row('Run OMP in', kind), row('WSL distribution', distro), row('OMP executable', omp, 'Leave empty to detect it.'), status, h('div', { class: 'set-actions' }, btn('Save and detect', save, 'primary')), h('p', { class: 'set-note' }, 'In WSL, projects on Windows drives are reached as /mnt/<drive>. Open sessions keep their current process.'));
}

async function ompConfig(el) {
  el.append(skeleton(5, 'pad'));
  let groups;
  try {
    groups = (await api.get('/api/omp/config')).groups;
  } catch (e) {
    return replace(el, h('div', { class: 'empty err-text' }, e.message));
  }
  const q = h('input', { type: 'search', placeholder: `Filter ${groups.reduce((n, g) => n + g.items.length, 0)} settings`, 'aria-label': 'Filter OMP settings' });
  const list = h('div', { class: 'omp-cfg' });
  const apply = async (key, value) => {
    try {
      await api.post('/api/omp/config', { key, value: String(value) });
      toast(`${key} saved. Applies to new sessions.`, 'ok', 2200);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const control = (it) => {
    if (it.type === 'boolean') return toggle(it.value === 'true', (v) => apply(it.key, v), it.key);
    if (it.type === 'enum') return h('select', { 'aria-label': it.key, onchange: (e) => apply(it.key, e.target.value) }, it.options.map((o) => h('option', { value: o, selected: o === it.value ? true : null }, o)));
    if (it.type === 'number' || it.type === 'string') return h('input', { type: 'text', value: it.value, 'aria-label': it.key, onchange: (e) => apply(it.key, e.target.value) });
    return h('code', { class: 'ell', title: it.value }, it.value);
  };
  const draw = () => {
    const f = q.value.toLowerCase();
    replace(list, groups.flatMap((g) => {
      const items = g.items.filter((i) => !f || i.key.toLowerCase().includes(f));
      return items.length ? [h('div', { class: 'list-h' }, g.name), ...items.map((it) => h('div', { class: 'set-row' }, h('div', { class: 'set-k' }, h('code', { class: 'set-l', title: it.key }, it.key)), h('div', { class: 'set-v' }, control(it))))] : [];
    }));
  };
  q.addEventListener('input', debounce(draw, 100));
  draw();
  replace(el, q, list, h('p', { class: 'set-note' }, 'OMP’s own settings, changed with omp config set. Lists and objects are read-only here; edit ~/.omp/agent/config.yml for those.'));
}
