// The project popover (the project's name in the toolbar, or ⋯ on a project in the sidebar): where it runs, Open in
// File Explorer or an editor (the last choice is remembered), project scripts that run in the Terminal, and
// Initialize Git for a folder that is not a repository yet.
import { h, icon, toast, baseName, copyText } from './dom.js';
import { api } from './api.js';
import { S, savePrefs, emit, activeTab } from './store.js';
import { popover, modal, btn } from './dialogs.js';
import { runInTerminal } from './terminal.js';

const infoCache = new Map(); // ws → { at, info }
export async function loadInfo(ws, force = false) {
  const hit = infoCache.get(ws);
  if (!force && hit && Date.now() - hit.at < 30000) return hit.info;
  const { info } = await api.get(`/api/project/info?ws=${encodeURIComponent(ws)}`);
  infoCache.set(ws, { at: Date.now(), info });
  return info;
}

const scriptsOf = (ws) => (Array.isArray(S.ui.projectScripts?.[ws]) ? S.ui.projectScripts[ws] : []);
const saveScripts = (ws, list) => savePrefs({ projectScripts: { ...(S.ui.projectScripts || {}), [ws]: list.slice(0, 20) } });

function addScript(ws, after) {
  const name = h('input', { type: 'text', placeholder: 'Dev server', maxlength: 40, 'aria-label': 'Name', spellcheck: 'false' });
  const cmd = h('input', { type: 'text', class: 'mono', placeholder: 'npm run dev', maxlength: 500, 'aria-label': 'Command', spellcheck: 'false', autocomplete: 'off' });
  const err = h('small', { class: 'field-err', role: 'alert', hidden: true });
  const save = () => {
    const c = cmd.value.trim();
    const n = name.value.trim() || c.split(/\s+/).slice(0, 3).join(' ');
    if (!c) return (err.textContent = 'Enter the command to run'), (err.hidden = false), cmd.focus();
    saveScripts(ws, [...scriptsOf(ws).filter((s) => s.name !== n), { name: n, command: c }]);
    m.close();
    toast(`Added “${n}”. Run it from the project menu.`, 'ok', 2400);
    after?.();
  };
  for (const f of [name, cmd]) f.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && (e.preventDefault(), save()));
  const m = modal({
    title: 'Add project script', size: 'sm', initialFocus: cmd,
    body: h('div', { class: 'pj-form' },
      h('p', { class: 'muted' }, `A command for ${baseName(ws)} that you run often. It runs in this project’s Terminal.`),
      h('label', { class: 'field' }, h('span', null, 'Command'), cmd),
      h('label', { class: 'field' }, h('span', null, 'Name'), name), err),
    actions: [btn('Cancel', () => m.close()), btn('Add script', save, 'primary')],
  });
}

/** Open the popover for project `ws` under `anchor`. `extra`: more menu rows ({ icon, label, run }) at the end. */
export function projectPopover(ws, anchor, extra = []) {
  if (!ws) return;
  const envRow = h('div', { class: 'pj-env' }, h('span', { class: 'pj-env-l skel-t' }, ' '));
  const openRow = h('div', { class: 'pj-open' });
  const scripts = h('div', { class: 'pj-scripts' });
  const gitRow = h('div', { class: 'pj-git' });
  const item = (ic, label, run, cls = '') => h('button', { class: `pj-it ${cls}`.trim(), type: 'button', onclick: () => (pop.close(false), run()) }, icon(ic, 14), h('span', { class: 'grow ell' }, label));
  const drawScripts = () => scripts.replaceChildren(
    ...scriptsOf(ws).map((s) => h('div', { class: 'pj-script' },
      h('button', { class: 'pj-it', type: 'button', title: s.command, onclick: () => (pop.close(false), runInTerminal(s.command)) }, icon('play', 13), h('span', { class: 'grow ell' }, s.name), h('code', { class: 'ell' }, s.command)),
      h('button', { class: 'pj-x', type: 'button', title: `Remove ${s.name}`, 'aria-label': `Remove ${s.name}`, onclick: () => (saveScripts(ws, scriptsOf(ws).filter((x) => x !== s)), drawScripts()) }, icon('x', 12)))),
    item('plus', 'Add project script', () => addScript(ws)));
  const pop = popover(anchor, [envRow, openRow, h('div', { class: 'pj-sep' }), scripts, gitRow, extra.length ? h('div', { class: 'pj-sep' }) : null, ...extra.map((x) => item(x.icon, x.label, x.run))].filter(Boolean), { cls: 'pj-pop', label: baseName(ws) });
  drawScripts();
  loadInfo(ws).then((info) => {
    if (!pop.el.isConnected) return;
    const e = info.env;
    const label = e.kind === 'wsl' ? `${e.user ? `${e.user} ` : ''}WSL (${e.distro})` : e.kind === 'windows' ? `${e.user} · Windows` : `${e.user} · Linux`;
    envRow.replaceChildren(icon(e.kind === 'windows' ? 'laptop' : 'terminal', 14), h('span', { class: 'pj-env-l ell', title: ws }, label),
      h('button', { class: 'ibtn sm', type: 'button', title: 'Copy the folder path', 'aria-label': 'Copy the folder path', onclick: () => copyText(ws).then(() => toast('Path copied', 'ok', 1200)) }, icon('copy', 13)));
    // Open in…: the remembered app first; the chevron lists every installed one.
    const apps = info.apps;
    const last = apps.find((a) => a.id === S.ui.openWith) || apps[0];
    const go = (a) => {
      pop.close(false);
      if (a.id !== S.ui.openWith) savePrefs({ openWith: a.id });
      api.post('/api/project/open', { ws, app: a.id }).catch((er) => toast(er.message, 'error'));
    };
    const list = h('div', { class: 'pj-apps', hidden: true }, apps.map((a) => h('button', { class: 'pj-it', type: 'button', onclick: () => go(a) }, icon(a.id === 'explorer' ? 'folder' : a.id === 'wt' ? 'terminal' : 'code', 14), h('span', { class: 'grow' }, a.name), a.id === last.id ? icon('check', 13) : null)));
    const chev = h('button', { class: 'pj-chev', type: 'button', title: 'Open in another app', 'aria-label': 'Open in another app', 'aria-expanded': 'false', onclick: () => {
      list.hidden = !list.hidden;
      chev.setAttribute('aria-expanded', String(!list.hidden));
      pop.el._place?.();
    } }, icon('chevron-down', 13));
    openRow.replaceChildren(h('div', { class: 'pj-split' }, h('button', { class: 'pj-it pj-main', type: 'button', onclick: () => go(last) }, icon(last.id === 'explorer' ? 'folder' : last.id === 'wt' ? 'terminal' : 'code', 14), h('span', { class: 'grow ell' }, `Open in ${last.name}`)), apps.length > 1 ? chev : null), list);
    if (!info.repo && !info.gitMissing) {
      gitRow.replaceChildren(h('div', { class: 'pj-sep' }), item('branch', 'Initialize Git', async () => {
        try {
          await api.post('/api/git/init', { ws });
          infoCache.delete(ws);
          toast(`Initialized a Git repository in ${baseName(ws)}`, 'ok', 2400);
          emit('tab:panel', activeTab(), 'git');
          emit('git:init', ws);
        } catch (er) {
          toast(er.message, 'error');
        }
      }));
    } else if (info.branch) gitRow.replaceChildren(h('div', { class: 'pj-sep' }), h('div', { class: 'pj-note' }, icon('branch', 13), h('span', { class: 'ell' }, info.branch)));
    pop.el._place?.();
  }, (er) => pop.el.isConnected && envRow.replaceChildren(h('span', { class: 'pj-env-l err-text' }, er.message)));
  return pop;
}
