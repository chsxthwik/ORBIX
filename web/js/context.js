// What a conversation works with, from one button in the toolbar: where the project runs (Windows, or which WSL
// distribution), its MCP servers, the skills the agent can use and the rule files it reads. Each opens to the side
// with the items and what you can do with them (insert a skill, open a rule file, add servers, copy a config path).
import { h, toast, copyText, baseName } from './dom.js';
import { api } from './api.js';
import { emit } from './store.js';
import { cascade } from './dialogs.js';
import { loadInfo } from './project.js';
import { viewFile } from './panels.js';

const q = (ws) => (ws ? `?ws=${encodeURIComponent(ws)}` : '');
const sep = (ws) => (/^[A-Za-z]:\\|^\\\\/.test(ws) ? '\\' : '/');
const TRIGGER = { always_on: 'Always', model_decision: 'When relevant', glob: 'By file pattern', manual: 'On request' };

/** Where `ws` runs, in a few words: "kali-linux", "Windows", "Linux". */
function envName(info) {
  const e = info?.env;
  if (!e) return '';
  return e.kind === 'wsl' ? e.distro || 'WSL' : e.kind === 'windows' ? 'Windows' : 'Linux';
}

/**
 * Open the context menu under `anchor` for project `ws`. `tab`: the open conversation (rule files open in its side
 * panel), `go(view)`: a page (Plugins, Skills), `settings(page)`: a Settings page.
 */
export function contextMenu(anchor, { ws, tab, go, settings }) {
  if (!ws) return;
  const mcp = api.get(`/api/mcp${q(ws)}`);
  const skills = api.get(`/api/skills${q(ws)}`).then((r) => r.skills || []);
  const rules = api.get(`/api/project/rules${q(ws)}`).catch(() => ({ instructions: [], rules: [] }));
  for (const p of [mcp, skills, rules]) p.catch(() => {});
  const count = (p, n) => {
    const el = h('span', { class: 'xm-n num' }, '');
    p.then((x) => (el.textContent = String(n(x))), () => (el.textContent = '!'));
    return el;
  };
  const servers = (m) => [...(m.servers || []), ...(m.project?.servers || [])];

  const envEl = h('span', { class: 'ell' }, baseName(ws));
  const head = h('div', { class: 'xm-head', title: ws }, envEl);
  loadInfo(ws).then((info) => envEl.isConnected && (envEl.textContent = envName(info) || baseName(ws)), () => {});

  const mcpItems = async () => {
    const m = await mcp;
    const list = servers(m);
    return [
      ...list.map((s) => {
        const off = s.config?.disabled;
        const state = off ? 'Off' : s.status === 'running' ? `${s.tools?.length || 0} tools` : s.status === 'error' ? 'Error' : 'Starts with a message';
        return { label: s.name, dot: off ? '' : s.status === 'running' ? 'ok' : s.status === 'error' ? 'bad' : 'idle', hint: s.scope === 'project' ? `Project · ${state}` : state, title: s.error || null, run: () => settings('tools') };
      }),
      list.length ? '-' : null,
      { icon: 'puzzle', label: 'Add from Plugins', run: () => go('customizations') },
      { icon: 'cog', label: 'Edit MCP servers', run: () => settings('tools') },
      { icon: 'copy', label: 'Copy configuration file path', run: () => copyText(m.file).then(() => toast('Path copied', 'ok', 1200)) },
    ];
  };

  const skillItems = async () => {
    const list = await skills;
    return [
      ...list.map((k) => ({ icon: 'bolt', label: k.name, hint: k.scope === 'project' ? 'Project' : '', title: k.description || null, run: () => emit('insert', `/skill:${k.name} `) })),
      list.length ? '-' : null,
      { icon: 'plus', label: 'New skill', run: () => go('skills') },
      { icon: 'copy', label: 'Copy the project’s skills folder path', run: () => copyText(`${ws.replace(/[\\/]+$/, '')}${sep(ws)}.agents${sep(ws)}skills`).then(() => toast('Path copied', 'ok', 1200)) },
    ];
  };

  const ruleItems = async () => {
    const r = await rules;
    const open = (p) => (tab ? viewFile(tab, p) : toast('Open a conversation to read it in the side panel.', 'info', 2200));
    const files = (r.instructions || []).map((f) => ({ icon: 'file', label: baseName(f.path), hint: f.truncated ? 'Cut to fit' : '', title: f.path, run: () => open(f.path) }));
    const own = (r.rules || []).map((x) => ({ icon: 'list', label: x.name.replace(/\.md$/i, ''), hint: TRIGGER[x.trigger] || '', title: x.description || x.path, run: () => open(x.path) }));
    return [
      ...files,
      files.length && own.length ? '-' : null,
      own.length ? { header: '.agents/rules' } : null,
      ...own,
      files.length || own.length ? '-' : null,
      { icon: 'cog', label: 'Project settings', run: () => settings(`proj:${ws}`) },
    ];
  };

  return cascade(anchor, [
    { icon: 'plug', label: 'MCP', count: count(mcp, (m) => servers(m).length), sub: mcpItems },
    { icon: 'bolt', label: 'Skills', count: count(skills, (l) => l.length), sub: skillItems },
    { icon: 'file', label: 'Rules', count: count(rules, (r) => (r.instructions?.length || 0) + (r.rules?.length || 0)), sub: ruleItems },
  ], { head, cls: 'ctx-pop', label: 'Context', align: 'end' });
}
