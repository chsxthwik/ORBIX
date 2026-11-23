// Plugins (sidebar → Plugins): a page with Marketplace and Installed and one search box. Marketplace adds well-known
// MCP servers with one click (catalog.mjs has their exact configs); Installed lists what the agent can use in the open
// project: MCP servers. Skills and rules are managed on their own pages.
import { h, icon, replace, toast, baseName, skeleton, errorState, onEnter } from './dom.js';
import { api } from './api.js';
import { activeTab } from './store.js';
import { modal, btn, folderPicker } from './dialogs.js';
import { homeProject } from './home.js';
import { CATALOG, CATEGORIES, configFor } from './catalog.mjs';
import { editMcpServer, mcpServerCard } from './mcp.js';
import { hubProjects } from './hub-projects.js';
import { customizeTabs } from './customize-tabs.js';

let tab = 'market';
let query = '';
let page = null; // the mounted page, so a redraw of the hub keeps the search box and its caret
let data = null;
let ws;
let request = 0;

const project = () => ws ?? (activeTab()?.workspace || homeProject() || hubProjects()[0]?.[0] || '');

async function load() {
  const id = ++request;
  const path = project();
  let next;
  try {
    next = await api.get(`/api/mcp${path ? `?ws=${encodeURIComponent(path)}` : ''}`);
  } catch (e) {
    next = { error: e.message };
  }
  if (id !== request) return;
  data = next;
  render();
}

const installed = (id) => data?.servers?.some((s) => s.name === id) || data?.project?.servers?.some((s) => s.name === id);
const match = (...texts) => texts.join(' ').toLowerCase().includes(query.trim().toLowerCase());
/** A coloured monogram tile (no remote logos: the page loads nothing from outside). */
const tile = (e, size = 36) => {
  const el = h('span', { class: 'cz-tile', 'aria-hidden': 'true' }, e.mono);
  el.style.setProperty('--c', e.color);
  el.style.setProperty('--s', `${size}px`);
  return el;
};
/** Add a catalog entry: ask for its fields (a token, a folder) when it has any, then save it as a user server. */
async function add(e) {
  const save = async (values) => {
    const config = configFor(e, values);
    await api.post('/api/mcp/save', { name: e.id, config, createOnly: true });
    toast(`${e.name} added. Test it from Installed.`, 'ok', 3500);
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
  let saving = false;
  const go = async () => {
    if (saving) return;
    saving = true;
    try {
      await save(Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])));
      m.close();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saving = false;
    }
  };
  const m = modal({
    title: `Add ${e.name}`, size: 'sm',
    body: h('div', { class: 'cz-form' }, h('p', { class: 'muted small' }, e.blurb), ...rows, h('p', { class: 'muted small' }, 'Saved in the ORBIX data folder (mcp.json) on this PC and sent only to the server itself.')),
    actions: [btn('Cancel', () => m.close()), btn('Add', go, 'primary')],
  });
  for (const el of Object.values(inputs)) onEnter(el, go);
}

function addButton(e) {
  if (installed(e.id)) return h('span', { class: 'cz-added', title: `${e.name} is configured` }, icon('check', 13), 'Added');
  const b = btn('Add', () => add(e), 'sm');
  b.setAttribute('aria-label', `Add ${e.name}`);
  b.disabled = !data || !!data.error;
  return b;
}

function market() {
  const sections = CATEGORIES.map((c) => {
    const items = CATALOG.filter((e) => e.cat === c && match(e.name, e.blurb, e.cat));
    if (!items.length) return null;
    return h('section', { class: 'cz-sec' }, h('h3', null, c),
      h('div', { class: 'cz-grid' }, items.map((e) => h('div', { class: 'cz-item' }, tile(e), h('div', { class: 'cz-item-t' }, h('b', null, e.name), h('span', { class: 'ell2' }, e.blurb)), addButton(e)))));
  }).filter(Boolean);
  return [
    h('p', { class: 'cz-note' }, 'Built-in catalog of MCP server configurations. Add a server, then test it in Installed. Only add software and servers you trust.'),
    data?.error ? errorState(data.error, { title: 'Couldn’t check installed servers', retry: load }) : !data ? h('p', { class: 'muted small', role: 'status' }, 'Checking installed servers…') : null,
    sections.length ? sections : h('p', { class: 'cz-none', role: 'status' }, 'No plugins match your search.')];
}

function installedView() {
  if (!data) return skeleton(4);
  if (data.error) return errorState(data.error, { retry: load });
  const edit = h('div');
  const group = (title, servers, add, empty) => {
    const shown = servers.filter((s) => match(s.name));
    return h('section', { class: 'cz-sec' },
      h('h3', null, title, h('span', { class: 'cz-n num' }, servers.length), h('span', { class: 'grow' }), add),
      add ? edit : null,
      shown.length ? h('div', { class: 'cards' }, shown.map((s) => mcpServerCard(s, project(), edit, load))) :
        h('p', { class: 'cz-none' }, servers.length ? 'No servers match your search.' : empty));
  };
  const add = btn('Add custom server', () => editMcpServer(edit, { ws: project() }, (saved) => (replace(edit), saved && load())), 'primary sm');
  return [
    group('Your servers', data.servers, add, 'Nothing installed yet. Add a custom server or browse the Marketplace.'),
    data.project ? group('Project servers', data.project.servers, null, 'No servers in this project’s .mcp.json.') : null];
}

function render() {
  if (!page?.isConnected) return;
  replace(page.querySelector('.cz-body'), tab === 'market' ? market() : installedView());
  for (const b of page.querySelectorAll('.cz-tabs button')) b.setAttribute('aria-pressed', String(b.dataset.t === tab));
}

export function selectPluginsTab(value) {
  tab = value === 'installed' ? 'installed' : 'market';
  render();
}

/** Draw the page into the hub's section (`root`). A redraw of the hub keeps the page as it is. */
export function drawCustomizations(root) {
  if (page && root.contains(page)) return;
  ws ??= project();
  data = null;
  const projects = new Map(hubProjects());
  if (ws && !projects.has(ws)) projects.set(ws, baseName(ws));
  const scope = h('select', { class: 'sk-proj', 'aria-label': 'Plugin project', onchange: (e) => {
    ws = e.target.value;
    data = null;
    render();
    load();
  } }, h('option', { value: '', selected: !ws }, 'No project'), [...projects].map(([p, name]) => h('option', { value: p, selected: p === ws }, name)));
  const search = h('input', { type: 'search', class: 'cz-q', placeholder: 'Search plugins…', 'aria-label': 'Search plugins', value: query, spellcheck: 'false', autocomplete: 'off' });
  search.addEventListener('input', () => ((query = search.value), render()));
  const tabs = h('div', { class: 'cz-tabs', role: 'group', 'aria-label': 'Plugin view' }, [['market', 'Marketplace'], ['installed', 'Installed']].map(([t, l]) => h('button', { type: 'button', 'data-t': t, onclick: () => selectPluginsTab(t) }, l)));
  page = h('div', { class: 'hub cz' },
    h('header', { class: 'cz-head' }, h('h1', null, 'Customize'), h('span', { class: 'grow' }), scope, tabs),
    customizeTabs('customizations'),
    h('label', { class: 'cz-search' }, icon('search', 14), search),
    h('div', { class: 'cz-body' }));
  replace(root, page);
  render();
  load();
}

/** Forget the mounted page (the hub shows another view), so the next visit loads fresh. */
export function leaveCustomizations() {
  if (!page) return;
  request++;
  page = null;
  ws = undefined;
}
