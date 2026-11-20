// Customizations (sidebar → Customizations): a page with Marketplace and Installed and one search
// box. Marketplace adds well-known MCP servers with one click (catalog.mjs has their exact configs); Installed lists
// what the agent can use in the open project: MCP servers, skills, and the instruction and rule files.
import { h, icon, replace, toast, baseName, skeleton, errorState } from './dom.js';
import { api } from './api.js';
import { S, emit, activeTab } from './store.js';
import { modal, btn, confirmDialog, folderPicker, popMenu } from './dialogs.js';
import { homeProject } from './home.js';
import { CATALOG, CATEGORIES, FEATURED, configFor } from './catalog.mjs';

let tab = 'market';
let query = '';
let page = null; // the mounted page, so a redraw of the hub keeps the search box and its caret
let data = null; // { servers, skills, rules } or { error }

const project = () => activeTab()?.workspace || homeProject() || S.workspaces?.[0]?.path || '';

async function load() {
  const ws = project();
  const q = ws ? `?ws=${encodeURIComponent(ws)}` : '';
  try {
    const [mcp, sk, rules] = await Promise.all([api.get(`/api/mcp${q}`), api.get(`/api/skills${q}`).catch(() => ({ skills: [] })), ws ? api.get(`/api/project/rules${q}`).catch(() => null) : null]);
    data = { ws, servers: [...mcp.servers, ...(mcp.project?.servers || [])], skills: sk.skills || [], rules };
  } catch (e) {
    data = { error: e.message };
  }
  render();
}

const installed = (id) => !!data?.servers?.some((s) => s.name === id);
const match = (...texts) => !query || texts.join(' ').toLowerCase().includes(query.toLowerCase());
/** A coloured monogram tile (no remote logos: the page loads nothing from outside). */
const tile = (e, size = 36) => {
  const el = h('span', { class: 'cz-tile', 'aria-hidden': 'true' }, e.mono);
  el.style.setProperty('--c', e.color);
  el.style.setProperty('--s', `${size}px`);
  return el;
};
const plainTile = (size) => {
  const el = h('span', { class: 'cz-tile plain', 'aria-hidden': 'true' }, icon('plug', 14));
  el.style.setProperty('--s', `${size}px`);
  return el;
};

/** Add a catalog entry: ask for its fields (a token, a folder) when it has any, then save it as a user server. */
async function add(e) {
  const save = async (values) => {
    const config = configFor(e, values);
    await api.post('/api/mcp/save', { name: e.id, config });
    toast(`${e.name} added. It starts when a conversation first uses its tools.`, 'ok', 3500);
    await load();
  };
  if (!e.fields?.length) return save({}).catch((err) => toast(err.message, 'error'));
  const inputs = {};
  const rows = e.fields.map((f) => {
    const input = h('input', { type: f.secret ? 'password' : 'text', class: 'cz-in', placeholder: f.label, 'aria-label': f.label, autocomplete: 'off', spellcheck: 'false' });
    inputs[f.key] = input;
    const pick = f.folder ? btn('Choose…', async () => {
      const p = await folderPicker(input.value || project());
      if (p) input.value = p;
    }, 'sm') : null;
    return h('label', { class: 'cz-f' }, h('span', null, f.label), h('span', { class: 'cz-f-row' }, input, pick), f.hint ? h('small', null, f.hint) : null);
  });
  const go = async () => {
    try {
      await save(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
      m.close();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const m = modal({
    title: `Add ${e.name}`, size: 'sm',
    body: h('div', { class: 'cz-form' }, h('p', { class: 'muted small' }, e.blurb), ...rows, h('p', { class: 'muted small' }, 'Saved in the ORBIX data folder (mcp.json) on this PC and sent only to the server itself.')),
    actions: [btn('Cancel', () => m.close()), btn('Add', go, 'primary')],
  });
  for (const el of Object.values(inputs)) el.addEventListener('keydown', (ev) => ev.key === 'Enter' && (ev.preventDefault(), go()));
}

function addButton(e, big = false) {
  if (installed(e.id)) return h('span', { class: 'cz-added' + (big ? ' big' : ''), title: `${e.name} is installed` }, icon('check', 13), big ? 'Added' : null);
  return big ? btn('Add', () => add(e), 'primary sm cz-add-big') : h('button', { class: 'cz-add', type: 'button', title: `Add ${e.name}`, 'aria-label': `Add ${e.name}`, onclick: () => add(e) }, icon('plus', 15));
}

function market() {
  const f = CATALOG.find((e) => e.id === FEATURED);
  const hero = !query ? h('section', { class: 'cz-hero' },
    h('div', { class: 'cz-hero-art', 'aria-hidden': 'true' }, CATALOG.slice(0, 7).map((e, i) => h('span', { class: `cz-float f${i}` }, tile(e, 44)))),
    h('div', { class: 'cz-hero-t' }, h('small', null, 'Featured'), h('h2', null, f.name), h('p', null, f.blurb), h('div', { class: 'cz-hero-acts' }, addButton(f, true)))) : null;
  const sections = CATEGORIES.map((c) => {
    const items = CATALOG.filter((e) => e.cat === c && match(e.name, e.blurb, e.cat));
    if (!items.length) return null;
    return h('section', { class: 'cz-sec' }, h('h3', null, c),
      h('div', { class: 'cz-grid' }, items.map((e) => h('div', { class: 'cz-item' }, tile(e), h('div', { class: 'cz-item-t' }, h('b', null, e.name), h('span', { class: 'ell2' }, e.blurb)), addButton(e)))));
  }).filter(Boolean);
  return [hero, ...(sections.length ? sections : [h('p', { class: 'cz-none' }, 'Nothing in the marketplace matches.')]),
    h('p', { class: 'cz-note' }, 'Servers run on this PC with your permissions. Ones started with npx need Node.js where ORBIX runs commands (Windows or WSL). Their tools ask before they act, unless the server marks them read-only.')];
}

function installedView() {
  if (!data) return skeleton(4);
  if (data.error) return errorState(data.error, { retry: () => ((data = null), render(), load()) });
  const head = (title, n, extra = null) => h('h3', { class: 'cz-h' }, title, h('span', { class: 'cz-n num' }, n), h('span', { class: 'grow' }), extra);
  const servers = data.servers.filter((s) => match(s.name, JSON.stringify(s.config)));
  const what = (c) => (c.url ? c.url : [c.command, ...(c.args || [])].join(' '));
  const stat = (s) => (s.status === 'ready' ? h('span', { class: 'cz-st ok' }, `${s.tools?.length || 0} tools`) : s.status === 'failed' || s.error ? h('span', { class: 'cz-st err', title: s.error || '' }, 'Failed') : h('span', { class: 'cz-st' }, 'Starts when used'));
  const more = (s, el) => popMenu(el, [
    { icon: 'activity', label: 'Test it now', run: async () => {
      try {
        const { result } = await api.post('/api/mcp/test', { name: s.name, config: s.config, ws: data.ws });
        toast(`${s.name}: ${result.tools?.length ?? 0} tools`, 'ok', 3000);
      } catch (e) {
        toast(`${s.name}: ${e.message}`, 'error', 7000);
      }
    } },
    { icon: 'cog', label: 'Edit in Settings', run: () => emit('settings', 'tools') },
    s.scope === 'user' ? { icon: 'trash', label: 'Remove', danger: true, run: async () => {
      if (!(await confirmDialog('Remove MCP server', `Remove ${s.name}? Conversations that are open keep it until they restart.`, { ok: 'Remove', danger: true }))) return;
      await api.post('/api/mcp/remove', { name: s.name }).catch((e) => toast(e.message, 'error'));
      load();
    } } : null,
  ].filter(Boolean));
  const skills = data.skills.filter((k) => match(k.name, k.description));
  const rules = [...(data.rules?.instructions || []).map((f) => ({ name: baseName(f.path), path: f.path, tag: 'Instructions', d: f.path })), ...(data.rules?.rules || []).map((r) => ({ name: r.name, path: r.path, tag: { always_on: 'Always', model_decision: 'When relevant', glob: 'Matching files', manual: 'On @mention' }[r.trigger], d: r.description || r.globs || '' }))].filter((r) => match(r.name, r.d));
  const reveal = (p) => api.post('/api/fs/reveal', { path: p }).catch((e) => toast(e.message, 'error'));
  return [
    h('section', { class: 'cz-sec' }, head('MCP servers', servers.length, h('button', { class: 'link', type: 'button', onclick: () => emit('settings', 'tools') }, 'Add your own')),
      servers.length ? h('div', { class: 'cz-list' }, servers.map((s) => {
        const e = CATALOG.find((x) => x.id === s.name);
        const dots = h('button', { class: 'ibtn sm cz-more', type: 'button', 'aria-label': `More for ${s.name}` }, icon('more-v', 15));
        dots.addEventListener('click', () => more(s, dots));
        return h('div', { class: 'cz-row' }, e ? tile(e, 28) : plainTile(28), h('div', { class: 'cz-row-t' }, h('b', null, s.name, h('span', { class: 'tag' }, s.scope === 'project' ? 'Project' : 'Yours')), h('span', { class: 'ell' }, what(s.config))), stat(s), dots);
      })) : h('p', { class: 'cz-none' }, query ? 'No MCP server matches.' : 'None yet. Add one from the Marketplace.')),
    h('section', { class: 'cz-sec' }, head('Skills', skills.length),
      skills.length ? h('div', { class: 'cz-lines' }, skills.map((k) => h('button', { class: 'cz-line', type: 'button', title: k.path, onclick: () => reveal(k.path) }, h('b', null, `/${k.name}`), h('span', { class: 'tag' }, k.scope === 'project' ? 'Project' : 'Yours'), h('span', { class: 'ell' }, k.description)))) : h('p', { class: 'cz-none' }, 'No skills. A skill is a folder with a SKILL.md in .agents/skills (this project) or in the skills folder of the ORBIX data folder (every project).')),
    h('section', { class: 'cz-sec' }, head('Rules', rules.length),
      rules.length ? h('div', { class: 'cz-lines' }, rules.map((r) => h('button', { class: 'cz-line', type: 'button', title: r.path, onclick: () => reveal(r.path) }, h('b', null, r.name), h('span', { class: 'tag' }, r.tag), h('span', { class: 'ell' }, r.d)))) : h('p', { class: 'cz-none' }, data.ws ? 'No rules in this project. /init writes an AGENTS.md; Markdown files in .agents/rules add more.' : 'Open a project to see its rules.')),
  ];
}

function render() {
  if (!page?.isConnected) return;
  replace(page.querySelector('.cz-body'), tab === 'market' ? market() : installedView());
  for (const b of page.querySelectorAll('.cz-tabs button')) b.setAttribute('aria-selected', String(b.dataset.t === tab));
  const ws = data?.ws;
  page.querySelector('.cz-for').textContent = tab === 'installed' && ws ? `In ${baseName(ws)}` : '';
}

/** Draw the page into the hub's section (`root`). A redraw of the hub keeps the page as it is. */
export function drawCustomizations(root) {
  if (page && root.contains(page)) return;
  const search = h('input', { type: 'search', class: 'cz-q', placeholder: 'Search customizations…', 'aria-label': 'Search customizations', value: query, spellcheck: 'false', autocomplete: 'off' });
  search.addEventListener('input', () => ((query = search.value), render()));
  const tabs = h('div', { class: 'cz-tabs', role: 'tablist' }, [['market', 'Marketplace'], ['installed', 'Installed']].map(([t, l]) => h('button', { type: 'button', role: 'tab', 'data-t': t, 'aria-selected': String(t === tab), onclick: () => ((tab = t), render()) }, l)));
  page = h('div', { class: 'hub cz' },
    h('header', { class: 'cz-head' }, h('h1', null, 'Customizations'), h('span', { class: 'cz-for muted small' }), h('span', { class: 'grow' }), tabs),
    h('div', { class: 'cz-search' }, icon('search', 14), search),
    h('div', { class: 'cz-body' }));
  replace(root, page);
  render();
  data = null;
  load();
}

/** Forget the mounted page (the hub shows another view), so the next visit loads fresh. */
export function leaveCustomizations() {
  page = null;
}
