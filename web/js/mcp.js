// Settings → "Tools & MCP": the agent's tools, and the MCP servers it can start.
// Your servers live in the app's data/mcp.json; a project can add its own in .mcp.json (shown read-only here).
import { h, toast, replace, spinner, skeleton } from './dom.js';
import { api } from './api.js';
import { activeTab } from './store.js';
import { btn, confirmDialog } from './dialogs.js';
import { renderSearchSettings, renderHooksSettings } from './toolset.js';

const BUILTIN = [
  ['read, glob, grep', 'Read files and search the project.', false],
  ['web_fetch', 'Read a public web page as text. Local network addresses need your OK.', false],
  ['web_search', 'Search the web. Only available after you set up a search service (below).', false],
  ['task', 'Run read-only helper agents in parallel for research.', false],
  ['todo', 'Keep a task list (shown in the Plan panel).', false],
  ['write, edit', 'Change files. Each change can be undone.', true],
  ['bash', 'Run shell commands in the project.', true],
];

const EXAMPLE = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], env: {} };

const summary = (cfg) => (cfg?.url ? cfg.url : [cfg?.command, ...(cfg?.args || [])].filter(Boolean).join(' '));

function statusChip(s) {
  const cls = s.status === 'running' ? 'ok' : s.status === 'error' ? 'bad' : '';
  const label = s.config?.disabled ? 'Off' : s.status === 'running' ? `Running · ${s.tools?.length || 0} tools` : s.status ? s.status[0].toUpperCase() + s.status.slice(1) : '';
  return h('span', { class: `tag ${cls}`.trim(), title: s.error || '' }, label);
}

function toolList(tools) {
  if (!tools?.length) return h('p', { class: 'muted small' }, 'The server offers no tools.');
  return h('div', { class: 'mcp-tools' }, tools.map((t) => h('div', { class: 'mcp-tool' }, h('code', null, t.name), t.readOnly ? h('span', { class: 'tag' }, 'Read-only') : h('span', { class: 'tag warn', title: 'Asks before running (unless approvals are off)' }, 'Asks first'), t.description ? h('span', { class: 'muted small' }, t.description) : null)));
}

async function runTest(name, config, out, ws) {
  replace(out, h('div', { class: 'muted small row' }, spinner(12), 'Starting the server…'));
  try {
    const { result } = await api.post('/api/mcp/test', { name, config, ws });
    replace(out, h('div', { class: 'callout ok' }, `Connected${result.serverInfo?.name ? ` to ${result.serverInfo.name}${result.serverInfo.version ? ' ' + result.serverInfo.version : ''}` : ''} in ${(result.ms / 1000).toFixed(1)}s.`), toolList(result.tools));
  } catch (e) {
    replace(out, h('div', { class: 'callout bad prewrap' }, e.message));
  }
}

function editor(root, { name = '', config = EXAMPLE, isNew = true } = {}, done) {
  const nameIn = h('input', { type: 'text', value: name, placeholder: 'Name, for example filesystem', spellcheck: 'false', 'aria-label': 'Server name' });
  const ta = h('textarea', { class: 'mono mcp-json', rows: 9, spellcheck: 'false', 'aria-label': 'Server config (JSON)' });
  ta.value = JSON.stringify(config, null, 2);
  const out = h('div', { class: 'mcp-out' });
  const parse = () => {
    try {
      return JSON.parse(ta.value);
    } catch (e) {
      throw new Error(`The config is not valid JSON: ${e.message}`);
    }
  };
  const save = btn('Save', async () => {
    try {
      await api.post('/api/mcp/save', { name: nameIn.value.trim(), config: parse(), oldName: isNew ? null : name });
      toast('Saved. Open sessions use it from their next message.', 'ok', 3000);
      done(true);
    } catch (e) {
      toast(e.message, 'error', 7000);
    }
  }, 'primary');
  const test = btn('Test', async () => {
    let cfg;
    try {
      cfg = parse();
    } catch (e) {
      return replace(out, h('div', { class: 'callout bad' }, e.message));
    }
    test.disabled = true;
    await runTest(nameIn.value.trim() || 'test', cfg, out, activeTab()?.workspace);
    test.disabled = false;
  });
  replace(
    root,
    h('div', { class: 'card mcp-edit' },
      h('div', { class: 'card-h' }, h('strong', null, isNew ? 'Add an MCP server' : `Edit ${name}`)),
      h('p', null, 'A program: {"command", "args", "env"}. A server on the web: {"url", "headers"}. "disabled": true keeps it without starting it. Commands run where your sessions run.'),
      nameIn,
      ta,
      h('div', { class: 'card-f' }, save, test, btn('Cancel', () => done(false))),
      out,
    ),
  );
  setTimeout(() => (isNew ? nameIn : ta).focus(), 0);
}

export async function renderMcpSettings(root) {
  replace(root, skeleton(5, 'pad'));
  const ws = activeTab()?.workspace || '';
  let data;
  try {
    data = await api.get(`/api/mcp${ws ? `?ws=${encodeURIComponent(ws)}` : ''}`);
  } catch (e) {
    return replace(root, h('div', { class: 'callout bad' }, e.message));
  }
  const edit = h('div');
  const searchBox = h('div');
  const hooksBox = h('div');
  const reload = () => renderMcpSettings(root);

  const card = (s, editable) => {
    const out = h('div', { class: 'mcp-out' });
    const testBtn = btn('Test', async () => {
      testBtn.disabled = true;
      await runTest(s.name, s.config, out, ws);
      testBtn.disabled = false;
    });
    const actions = [testBtn];
    if (editable) {
      actions.push(btn('Edit', () => editor(edit, { name: s.name, config: s.config, isNew: false }, (saved) => (saved ? reload() : replace(edit)))));
      actions.push(btn('Remove', async () => {
        if (!(await confirmDialog('Remove MCP server', `Remove "${s.name}"? Open sessions stop using it with their next message.`, { ok: 'Remove', danger: true }))) return;
        try {
          await api.post('/api/mcp/remove', { name: s.name });
          reload();
        } catch (er) {
          toast(er.message, 'error');
        }
      }, 'danger'));
    }
    return h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('strong', null, s.name), statusChip(s)),
      h('code', { class: 'mcp-cmd ell', title: summary(s.config) }, summary(s.config)),
      s.error ? h('div', { class: 'callout bad prewrap' }, s.error) : null,
      s.status === 'running' && s.tools?.length ? h('p', null, s.tools.join(', ')) : null,
      h('div', { class: 'card-f' }, actions),
      out,
    );
  };

  const user = data.servers || [];
  const proj = data.project;
  replace(
    root,
    h('p', { class: 'set-note' }, 'MCP servers add tools such as databases, browsers or issue trackers. They start with your first message in a session and stop when it closes.'),
    h('h4', { class: 'set-sub' }, 'Built-in tools'),
    h('div', { class: 'mcp-builtin' }, BUILTIN.map(([n, d, asks]) => h('div', { class: 'mcp-tool' }, h('code', null, n), h('span', { class: `tag${asks ? ' warn' : ''}` }, asks ? 'Asks first' : 'No approval'), h('span', { class: 'muted' }, d)))),
    h('div', { class: 'mcp-head' }, h('h4', { class: 'set-sub' }, 'Your MCP servers'), btn('Add server', () => editor(edit, {}, (saved) => (saved ? reload() : replace(edit))), 'primary sm')),
    h('code', { class: 'mcp-cmd ell muted', title: data.file }, data.file),
    edit,
    user.length ? h('div', { class: 'cards' }, user.map((s) => card(s, true))) : h('p', { class: 'muted small' }, 'None yet.'),
    proj
      ? [
          h('h4', { class: 'set-sub' }, 'This project'),
          h('p', { class: 'muted small', title: proj.file }, proj.exists ? `From ${proj.file}. Edit that file to change them. Each one starts only after you allow it once.` : `No .mcp.json in this project. Add one at ${proj.file} to share servers with everyone who works on it.`),
          proj.servers.length ? h('div', { class: 'cards' }, proj.servers.map((s) => card(s, false))) : null,
        ]
      : h('p', { class: 'muted small' }, 'Open a session to see the servers its project defines in .mcp.json.'),
    searchBox,
    hooksBox,
    h('h4', { class: 'set-sub' }, 'Skills and commands'),
    h('p', { class: 'muted small' }, 'Skills are folders that contain a SKILL.md file. Put them in a project’s .agents/skills, .claude/skills or .omp/skills folder, or in the app’s data/skills folder. Custom slash commands are Markdown files in .claude/commands or .omp/commands (or data/commands). In a command file, $ARGUMENTS is replaced with whatever you type after the command. Type / in a session to see them all.'),
  );
  renderSearchSettings(searchBox);
  renderHooksSettings(hooksBox, ws);
}
