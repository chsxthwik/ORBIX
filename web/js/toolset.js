// Settings → Tools & MCP: the "Web search" service and the read-only "Hooks" overview.
import { h, toast, replace, spinner } from './dom.js';
import { api } from './api.js';
import { loadEngine, S } from './store.js';
import { btn, confirmDialog } from './dialogs.js';

const SERVICES = [
  ['brave', 'Brave Search', 'Paste an API key from the Brave Search API (it has a free plan).', 'https://brave.com/search/api/'],
  ['tavily', 'Tavily', 'Paste an API key from Tavily (it has a free plan).', 'https://tavily.com/'],
  ['searxng', 'SearXNG (your own)', 'The address of a SearXNG server you run. JSON output must be allowed there.', 'https://docs.searxng.org/'],
];

/** The web_search tool: pick a service and give its key (stored encrypted for your Windows account) or address. */
export async function renderSearchSettings(root) {
  let cur = S.engine?.search;
  if (!cur) cur = (await api.get('/api/engine').then((r) => r.engine.search).catch(() => null)) || {};
  const sel = h('select', { 'aria-label': 'Search service' }, h('option', { value: '' }, 'Choose a service…'), SERVICES.map(([v, l]) => h('option', { value: v, selected: cur.provider === v ? true : null }, l)));
  const key = h('input', { type: 'password', class: 'pv-key', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search API key' });
  const url = h('input', { type: 'text', class: 'pv-url', placeholder: 'http://localhost:8080', value: cur.baseUrl || '', spellcheck: 'false', 'aria-label': 'SearXNG address' });
  const help = h('p', { class: 'muted small' });
  const save = btn('Check & save', async () => {
    if (!sel.value) return toast('Choose a service first', 'error');
    save.disabled = true;
    save.textContent = 'Checking…';
    try {
      const r = await api.post('/api/engine/search', { provider: sel.value, key: key.value, baseUrl: url.value });
      key.value = '';
      await loadEngine();
      toast('Web search is on', 'ok', 2500);
      renderSearchSettings(root);
      return r;
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
    save.disabled = false;
    save.textContent = 'Check & save';
  }, 'primary sm');
  const off = cur.configured
    ? btn('Turn off', async () => {
        if (!(await confirmDialog('Turn off web search', 'The agent can no longer search the web. The saved key is deleted from this PC.', { ok: 'Turn off', danger: true }))) return;
        try {
          await api.post('/api/engine/search/clear');
          await loadEngine();
          renderSearchSettings(root);
        } catch (e) {
          toast(e.message, 'error');
        }
      }, 'sm')
    : null;
  const sync = () => {
    const svc = SERVICES.find(([v]) => v === sel.value);
    key.hidden = sel.value === 'searxng' || !sel.value;
    url.hidden = sel.value !== 'searxng';
    key.placeholder = cur.provider === sel.value && cur.hasKey ? 'Key saved. Paste a new one to replace it.' : sel.value === 'searxng' ? 'Key (only if your server needs one)' : 'Paste your API key';
    replace(help, svc ? [svc[2], ' ', h('button', { class: 'link', type: 'button', onclick: () => api.post('/api/open-url', { url: svc[3] }).catch((e) => toast(e.message, 'error')) }, 'Open the site')] : 'Without a service the agent has no web_search tool (it can still read a page with web_fetch).');
  };
  sel.addEventListener('change', sync);
  sync();
  replace(root,
    h('div', { class: 'mcp-head' }, h('h4', { class: 'set-sub' }, 'Web search'), cur.configured ? h('span', { class: 'tag ok' }, 'On') : h('span', { class: 'tag' }, 'Off')),
    h('p', { class: 'set-note' }, 'Lets the agent search the web for current facts and documentation. It sends only the search words to the service you choose. It is off until you set one up; it needs no approval once on.'),
    h('div', { class: 'pv-form' }, sel, url, key, save, off),
    help);
}

/** Hooks: commands that run before and after the agent's actions. Edited as files; shown here read-only. */
export async function renderHooksSettings(root, ws) {
  replace(root, h('h4', { class: 'set-sub' }, 'Hooks'), h('div', { class: 'muted small row' }, spinner(12), 'Loading…'));
  let data;
  try {
    data = await api.get(`/api/hooks${ws ? `?ws=${encodeURIComponent(ws)}` : ''}`);
  } catch (e) {
    return replace(root, h('h4', { class: 'set-sub' }, 'Hooks'), h('div', { class: 'callout bad' }, e.message));
  }
  const block = (title, d, scope, note) =>
    h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('strong', null, title), d.exists ? h('span', { class: `tag${d.errors.length ? ' warn' : d.hooks.length ? ' ok' : ''}` }, `${d.hooks.length} hook${d.hooks.length === 1 ? '' : 's'}`) : h('span', { class: 'tag' }, 'No file')),
      h('code', { class: 'mcp-cmd ell', title: d.file }, d.file),
      note ? h('p', { class: 'muted small' }, note) : null,
      d.errors.map((e) => h('div', { class: 'callout bad prewrap' }, e)),
      d.hooks.length ? h('div', { class: 'mcp-tools' }, d.hooks.map((x) => h('div', { class: 'mcp-tool' }, h('span', { class: 'tag' }, x.event), x.matcher ? h('code', null, x.matcher) : h('span', { class: 'muted small' }, 'all'), h('code', { class: 'ell hk-cmd', title: x.command }, x.command)))) : null,
      h('div', { class: 'card-f' }, btn(d.exists ? 'Show the file' : scope === 'user' ? 'Create & show the file' : 'Show the folder', () => api.post('/api/hooks/reveal', { scope, ws }).catch((e) => toast(e.message, 'error')))));
  const proj = data.project;
  replace(root,
    h('h4', { class: 'set-sub' }, 'Hooks'),
    h('p', { class: 'set-note' }, 'A hook is a command of yours that runs at a fixed moment: before a tool runs (PreToolUse), after it (PostToolUse), when you send a message (UserPromptSubmit) or when the agent is about to finish (Stop). It gets the details as JSON on its input. Exit code 2 stops the action and tells the agent why; any other failure is only a warning. Each hook has 10 seconds. Hooks are edited as files; this list is read-only.'),
    h('code', { class: 'mcp-cmd' }, '{ "hooks": { "PreToolUse": [ { "matcher": "bash|edit", "command": "node check.js" } ] } }'),
    block('Your hooks', data.user, 'user'),
    proj
      ? block('This project', proj, 'project', proj.exists ? (proj.hooks.length ? (proj.trusted ? 'You allowed these.' : 'They run only after you allow them once, the first time they would run.') : null) : 'Add .orbix/hooks.json to share hooks with everyone who works on this project. Each person is asked once before they run.')
      : h('p', { class: 'muted small' }, 'Open a session to see the hooks of its project (.orbix/hooks.json).'));
}
