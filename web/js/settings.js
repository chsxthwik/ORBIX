// Settings. The OMP CLI tab exists only when the optional OMP CLI is installed.
import { h, icon, toast, replace, clear, append } from './dom.js';
import { api } from './api.js';
import { S, savePrefs, defaultEngine, engineReady, loadEngine, loadEnv, loadSessions, emit, ompInstalled } from './store.js';
import { modal, btn, confirmDialog, shortcutsDialog, row, toggle } from './dialogs.js';
import { renderOmpSettings } from './omp-settings.js';
import { renderEngineSettings } from './engine.js';
import { renderMcpSettings } from './mcp.js';
import { openHelp } from './help.js';
import { openDiagnostics } from './diagnostics.js';

const TABS = [['start', 'Start here', 'compass'], ['engine', 'AI providers', 'key'], ['look', 'Appearance', 'palette'], ['behavior', 'Behavior', 'sliders'], ['tools', 'Tools & MCP', 'plug'], ['omp', 'OMP CLI', 'terminal'], ['about', 'About', 'info']];

/** Open Settings on a tab: start, engine, look, behavior, tools, omp, about. */
export function openSettings(initial = 'start') {
  let cur = TABS.some(([k]) => k === initial) ? initial : 'start';
  if (cur === 'omp' && !ompInstalled()) cur = 'start';
  let ompSub = 'signin';
  const names = TABS.filter(([k]) => k !== 'omp' || ompInstalled());
  const nav = h('nav', { class: 'set-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Settings sections' });
  const content = h('div', { class: 'set-content', role: 'tabpanel', tabindex: '-1' });
  const m = modal({ title: 'Settings', size: 'lg', cls: 'settings', body: h('div', { class: 'set-wrap' }, nav, content) });
  const show = (name, focusNav) => {
    cur = name;
    replace(nav, names.map(([k, l, ic]) => h('button', { type: 'button', role: 'tab', id: `set-${k}`, 'aria-selected': String(k === cur), tabindex: k === cur ? '0' : '-1', class: 'set-tab' + (k === cur ? ' cur' : ''), onclick: () => show(k) }, icon(ic, 15), l)));
    content.setAttribute('aria-labelledby', `set-${name}`);
    clear(content);
    content.scrollTop = 0;
    content.append(h('h3', { class: 'set-title' }, names.find(([k]) => k === name)[1]));
    const body = h('div', { class: 'set-body' });
    content.append(body);
    ({ start: tabStart, engine: renderEngineSettings, look: tabLook, behavior: tabBehavior, tools: renderMcpSettings, omp: (el) => renderOmpSettings(el, ompSub, (s) => ((ompSub = s), show('omp'))), about: tabAbout })[name](body, show, m);
    if (focusNav) nav.querySelector('.cur')?.focus();
  };
  nav.addEventListener('keydown', (e) => {
    const i = names.findIndex(([k]) => k === cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show(names[(i + (e.key === 'ArrowDown' ? 1 : -1) + names.length) % names.length][0], true);
    }
  });
  show(cur);
  setTimeout(() => nav.querySelector('.cur')?.focus({ preventScroll: true }), 0);
  return m;
}

function tabStart(el, show, m) {
  const b = S.env.backend;
  const ready = engineReady();
  const omp = ompInstalled();
  const names = (S.engine?.providers || []).filter((p) => p.configured).map((p) => p.name).join(', ');
  const eng = defaultEngine();
  const pick = h('select', { 'aria-label': 'New sessions use', onchange: () => savePrefs({ defaultEngine: pick.value }) }, h('option', { value: 'builtin', selected: eng === 'builtin' ? true : null }, 'ORBIX agent'), h('option', { value: 'omp', selected: eng === 'omp' ? true : null }, 'OMP CLI'));
  append(el, [
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('strong', null, 'ORBIX agent'), h('span', { class: 'tag' + (ready ? ' ok' : ' warn') }, ready ? 'Ready' : 'Needs a provider')), h('p', null, ready ? `Uses ${names}.` : 'Add an API key or a local model to use it. Nothing else to install.'), h('div', { class: 'card-f' }, btn(ready ? 'Manage providers' : 'Set up a provider', () => show('engine'), ready ? '' : 'primary'))),
    omp ? h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('strong', null, 'OMP CLI'), h('span', { class: 'tag ok' }, 'Installed')), h('p', null, `${b.ompVersion || 'OMP'} in ${b.kind === 'wsl' ? 'WSL ' + b.distro : 'Windows'}. Optional: run a session with it instead of the ORBIX agent.`), h('div', { class: 'card-f' }, btn('OMP CLI settings', () => show('omp')))) : null,
    omp ? row('New sessions use', pick, 'You can also choose on the home screen.') : null,
    h('div', { class: 'set-actions' }, btn('New session', () => {
      m.close();
      emit('home');
    }, 'primary'), btn('Check my setup', () => openDiagnostics()), btn('How ORBIX works', () => openHelp())),
  ]);
}

function tabLook(el) {
  const u = S.ui;
  const theme = u.theme || 'system';
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Theme' }, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']].map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(theme === v), onclick: (e) => {
    savePrefs({ theme: v });
    for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
  } }, l)));
  const val = h('span', { class: 'num range-v' }, `${u.fontSize || 14}px`);
  const size = h('input', { type: 'range', min: 12, max: 18, step: 1, value: u.fontSize || 14, 'aria-label': 'Message text size', oninput: () => ((val.textContent = size.value + 'px'), savePrefs({ fontSize: +size.value })) });
  el.append(row('Theme', seg), row('Message text size', h('div', { class: 'row' }, size, val)), row('Show model thinking', toggle(u.showThinking !== false, (v) => savePrefs({ showThinking: v }), 'Show model thinking'), 'Collapsed reasoning blocks in replies.'));
}

function tabBehavior(el) {
  const approvals = h('select', { 'aria-label': 'File edits and commands', onchange: async () => {
    try {
      await api.post('/api/engine/settings', { approvals: approvals.value });
      await loadEngine();
      toast('Saved', 'ok', 1200);
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, h('option', { value: 'ask', selected: S.engine?.approvals !== 'auto' ? true : null }, 'Ask me first'), h('option', { value: 'auto', selected: S.engine?.approvals === 'auto' ? true : null }, 'Allow everything'));
  el.append(whereRow(), row('File edits and commands', approvals, `Reading and searching never ask.${ompInstalled() ? ' OMP CLI sessions use OMP’s own approval settings.' : ''}`), row('Follow new output', toggle(S.ui.autoScroll !== false, (v) => savePrefs({ autoScroll: v }), 'Follow new output'), 'Scroll to the newest text while it streams, unless you scrolled up.'));
}

/** Where the agent runs shell commands: Windows, or one of the installed WSL distributions. */
function whereRow() {
  const b = S.env.backend;
  const cur = b.kind === 'wsl' ? 'wsl|' + b.distro : 'native|';
  const sel = h('select', { 'aria-label': 'Run commands in' }, h('option', { value: 'native|' }, 'Windows'), b.kind === 'wsl' ? h('option', { value: cur }, (b.distro ? `WSL · ${b.distro}` : 'WSL · default distribution')) : null);
  sel.value = cur;
  api.get('/api/env').then((env) => {
    for (const d of env.distros || []) if (!sel.querySelector(`option[value="wsl|${CSS.escape(d)}"]`)) sel.append(h('option', { value: 'wsl|' + d }, `WSL · ${d}`));
    sel.value = cur;
  }).catch(() => {});
  sel.addEventListener('change', async () => {
    const [kind, distro] = sel.value.split('|');
    try {
      await api.post('/api/backend', { kind, distro, ompPath: b.ompPath || '' });
      await loadEnv();
      loadSessions();
      emit('env');
      emit('prefs', {});
      toast('Saved. New sessions run commands there.', 'ok', 3500);
    } catch (e) {
      toast(e.message, 'error');
      sel.value = cur;
    }
  });
  return row('Run commands in', sel, 'Projects on Windows drives are reached from WSL as /mnt/c/….');
}

function tabAbout(el) {
  const b = S.env.backend;
  el.append(
    row('Version', S.env.app.version),
    row('Commands run in', b.kind === 'wsl' ? `WSL (${b.distro})` : 'Windows'),
    row('OMP CLI', b.resolvedOmp ? b.ompVersion || 'Installed' : 'Not installed', 'Optional. ORBIX works fully without it.'),
    h('div', { class: 'set-actions' }, btn('How ORBIX works', () => openHelp()), btn('Keyboard shortcuts', () => shortcutsDialog()), h('span', { class: 'grow' }), btn('Quit ORBIX', async () => {
      if (await confirmDialog('Quit ORBIX', 'Stop all sessions and close ORBIX?', { ok: 'Quit', danger: true })) {
        await api.post('/api/quit').catch(() => {});
        window.chrome?.webview?.postMessage('quit'); // the native window closes itself
      }
    }, 'danger')),
  );
}
