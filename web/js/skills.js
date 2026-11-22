// Skills (sidebar → Skills): the instructions the agent follows for a kind of task. A skill is a folder with a SKILL.md
// (name, one-line description, instructions); the agent sees every skill's name and description and reads the file
// when a task fits. This page lists the open project's skills and yours, and creates, edits and deletes them.
import { h, icon, toast, replace, baseName, errorState, skeleton } from './dom.js';
import { api } from './api.js';
import { S, activeTab, groupSessions, emit } from './store.js';
import { btn, confirmDialog } from './dialogs.js';

let host = null;
let ws = '';
let list = null;
let error = '';
let query = '';
let form = null; // { original?, name, description, body, scope }

const projects = () => {
  const seen = new Map();
  for (const g of groupSessions()) if (g.path) seen.set(g.path, g.name);
  for (const w of S.workspaces || []) seen.set(w.path, w.name || baseName(w.path));
  return [...seen.entries()];
};

async function load() {
  error = '';
  try {
    const r = await api.get(`/api/skills${ws ? `?ws=${encodeURIComponent(ws)}` : ''}`);
    list = r.skills;
    if (!ws && r.ws) ws = r.ws;
  } catch (e) {
    error = e.message;
  }
  draw();
}

async function edit(k) {
  try {
    const r = await api.get(`/api/skills/file?ws=${encodeURIComponent(ws)}&name=${encodeURIComponent(k.name)}`);
    form = { original: k.name, name: k.name, description: r.description, body: r.body.trim(), scope: k.scope };
    draw();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function remove(k) {
  if (!(await confirmDialog('Delete skill', `Delete “${k.name}”? Its folder moves to the ORBIX trash (data\\trash\\skills), so you can put it back.`, { ok: 'Delete', danger: true }))) return;
  try {
    list = (await api.post('/api/skills/delete', { ws, name: k.name })).skills;
    toast(`Deleted ${k.name}`, 'ok', 1800);
  } catch (e) {
    toast(e.message, 'error');
  }
  draw();
}

function editor() {
  const f = form;
  const name = h('input', { type: 'text', value: f.name || '', placeholder: 'release-notes', 'aria-label': 'Name', maxlength: 64, spellcheck: 'false', disabled: f.original ? true : null });
  const desc = h('input', { type: 'text', value: f.description || '', placeholder: 'Use when writing release notes from the commits since the last tag', 'aria-label': 'When to use it', maxlength: 500 });
  const body = h('textarea', { rows: 12, placeholder: 'The steps the agent follows, in Markdown.', 'aria-label': 'Instructions' }, f.body || '');
  const scope = h('select', { 'aria-label': 'Where', disabled: f.original ? true : null },
    h('option', { value: 'project', selected: f.scope !== 'user', disabled: ws ? null : true }, ws ? `This project (${baseName(ws)}/.agents/skills)` : 'This project (open one first)'),
    h('option', { value: 'user', selected: f.scope === 'user' || !ws }, 'Every project (yours)'));
  const save = async () => {
    try {
      list = (await api.post('/api/skills/save', { ws, scope: scope.value, original: f.original, name: name.value, description: desc.value, body: body.value })).skills;
      toast(f.original ? 'Saved' : 'Skill added. The agent sees it from the next message.', 'ok', 2600);
      form = null;
      draw();
    } catch (e) {
      toast(e.message, 'error', 5000);
    }
  };
  setTimeout(() => (f.original ? body : name).focus(), 0);
  return h('section', { class: 'au-form sk-form', 'aria-label': f.original ? 'Edit skill' : 'New skill' },
    h('h2', null, f.original ? `Edit ${f.original}` : 'New skill'),
    h('label', { class: 'au-f' }, h('span', null, 'Name'), name),
    h('label', { class: 'au-f' }, h('span', null, 'When the agent should use it'), desc),
    h('label', { class: 'au-f' }, h('span', null, 'Instructions'), body),
    h('div', { class: 'au-row' }, h('label', { class: 'au-f grow' }, h('span', null, 'Where'), scope)),
    h('div', { class: 'au-acts' }, btn(f.original ? 'Save' : 'Add skill', save, 'primary'), btn('Cancel', () => ((form = null), draw()))));
}

function row(k) {
  return h('article', { class: 'au-item sk-item' },
    h('div', { class: 'au-main' },
      h('div', { class: 'au-title' }, icon('bolt', 15), h('strong', { class: 'ell', title: k.name }, k.name), h('span', { class: 'tag' }, k.scope === 'project' ? 'Project' : 'Yours')),
      k.description ? h('p', { class: 'au-prompt' }, k.description) : null,
      h('div', { class: 'au-meta' }, h('span', { class: 'ell', title: k.path }, k.path))),
    h('div', { class: 'au-side' },
      h('div', { class: 'au-acts' },
        btn('Use', () => (emit('insert', `/skill:${k.name} `), activeTab() ? null : toast('Open a conversation, then type /skill:' + k.name, 'info', 3000)), 'sm'),
        btn('Edit', () => edit(k), 'sm'),
        btn('Delete', () => remove(k), 'sm danger'))));
}

function draw() {
  if (!host?.isConnected) return;
  const projs = projects();
  const pick = h('select', { class: 'sk-proj', 'aria-label': 'Project', onchange: (e) => ((ws = e.target.value), (list = null), (form = null), draw(), load()) },
    projs.length ? projs.map(([p, n]) => h('option', { value: p, selected: p === ws }, n)) : h('option', { value: '' }, 'No project open'));
  const search = h('input', { type: 'search', class: 'sk-q', placeholder: 'Search skills', 'aria-label': 'Search skills', value: query, spellcheck: 'false', autocomplete: 'off' });
  search.addEventListener('input', () => {
    query = search.value;
    replace(host.querySelector('.sk-list'), body());
  });
  const body = () => {
    if (error) return errorState(error, { retry: load });
    if (!list) return skeleton(3);
    const q = query.trim().toLowerCase();
    const shown = list.filter((k) => !q || `${k.name} ${k.description}`.toLowerCase().includes(q));
    if (!list.length) return h('div', { class: 'empty' }, icon('bolt', 22), h('b', null, 'No skills yet'), h('span', null, 'A skill teaches the agent one kind of task: how you write release notes, review a pull request, or set up a service. Add one, and the agent uses it when a task fits.'));
    if (!shown.length) return h('p', { class: 'cz-none' }, 'No skill matches.');
    const group = (title, items) => (items.length ? h('section', { class: 'sk-group' }, h('h2', null, title), ...items.map(row)) : null);
    return [group('This project', shown.filter((k) => k.scope === 'project')), group('Yours, in every project', shown.filter((k) => k.scope === 'user'))];
  };
  replace(host,
    h('div', { class: 'hub' },
      h('header', { class: 'hub-head au-head' },
        h('h1', null, 'Skills'),
        h('div', { class: 'au-head-acts' }, pick, form ? null : h('button', { class: 'btn sm au-new', type: 'button', onclick: () => ((form = { scope: ws ? 'project' : 'user' }), draw()) }, icon('plus', 13), 'New skill'))),
      form ? editor() : h('div', { class: 'cz-search sk-search' }, icon('search', 14), search),
      h('div', { class: 'au-list sk-list' }, body())));
}

/** Draw the page into the hub's section (`root`). */
export function drawSkills(root) {
  const fresh = host !== root || !root.querySelector('.sk-list');
  host = root;
  if (!ws) ws = activeTab()?.workspace || projects()[0]?.[0] || '';
  if (fresh) {
    list = null;
    load();
  }
  if (form && root.querySelector('.sk-form')) return; // a redraw while you edit keeps the form
  draw();
}
