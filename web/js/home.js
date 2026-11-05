// Home: a composer to start a session (project, engine, model), the projects, and the recent conversations.
// Shown when no session tab is active. With no AI provider set up it shows the first-run steps instead.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, defaultEngine, engineReady, ompInstalled, savePrefs, groupSessions, on } from './store.js';
import { popMenu, modelPicker, isApproval } from './dialogs.js';

// The home screen is redrawn when sessions or providers change. The message box itself stays mounted (so typing,
// IME composition and the caret are never interrupted); only the parts around it are redrawn.
const draft = { draft: '', attach: [], project: '', ephemeral: false };
let models = null; // models of the configured providers, fetched once per provider change
let C = null; // the mounted home view: { wrap, comp, row, heroSlot, tabsSlot, footSlot, lowerSlot, keysSlot }
let starting = false;
on('engine', () => (models = null));

/** Choose the project the next session starts in (used by "New session in this project"). */
export function setHomeProject(path, { ephemeral } = {}) {
  if (path) draft.project = path;
  if (ephemeral != null) draft.ephemeral = ephemeral;
}

/** The saved model choice for new agent sessions, if its provider is still set up. */
function homeModel() {
  const m = S.ui.homeModel;
  if (!m?.provider || !m.id) return null;
  return S.engine?.providers?.some((p) => p.id === m.provider && p.configured) ? m : null;
}

/** Model list without an open session: borrow a running agent tab, or ask a short-lived unsaved one. */
async function loadHomeModels(workspace) {
  if (models) return models;
  const tab = [...S.tabs.values()].find((t) => t.engine === 'builtin' && !t.dead && t.ready);
  if (tab) {
    models = tab.models || (await rpc(tab.id, { type: 'get_available_models' })).data.models || [];
    return models;
  }
  if (!workspace) throw new Error('Choose a project folder first.');
  const j = await api.post('/api/proc/start', { workspace, engine: 'builtin', noSession: true });
  try {
    models = (await rpc(j.id, { type: 'get_available_models' })).data.models || [];
  } finally {
    api.post('/api/proc/stop', { proc: j.id }).catch(() => {});
  }
  return models;
}

export function drawHome(root, H) {
  const ompOk = ompInstalled();
  const agentOk = engineReady();
  const redraw = () => {
    drawHome(root, H);
    C?.comp.focus();
  };
  if (!agentOk && !ompOk) {
    C = null;
    replace(root, h('div', { class: 'home' }, setupCard(H), S.sessions.length ? recentList(H) : null));
    return;
  }

  const projects = groupSessions().filter((g) => g.path);
  if (!projects.some((g) => g.path === draft.project)) draft.project = projects[0]?.path || '';
  let engine = defaultEngine();
  if (engine === 'builtin' && !agentOk && ompOk) engine = 'omp';

  if (!C || !root.contains(C.wrap)) {
    const comp = new Composer({
      placeholder: 'Describe a task. For example: find why the login test fails and fix it',
      label: 'Task for the new session',
      cls: 'home-composer',
      state: draft,
      workspace: () => draft.project,
      onSubmit: () => C?.start(),
      onChange: () => C?.go && (C.go.disabled = starting),
    });
    const row = h('div', { class: 'c-row' });
    comp.el.append(row);
    // Layout: hero, then the launch panel (project tabs, the task box, what the session will use), then the lower grid.
    const heroSlot = h('div');
    const tabsSlot = h('div', { class: 'launch-tabs' });
    const footSlot = h('div', { class: 'launch-foot' });
    const launch = h('div', { class: 'launch' }, tabsSlot, comp.el, footSlot);
    const lowerSlot = h('div');
    const keysSlot = h('div');
    const wrap = h('div', { class: 'home' }, heroSlot, launch, lowerSlot, keysSlot);
    C = { wrap, comp, row, heroSlot, tabsSlot, footSlot, lowerSlot, keysSlot };
    // One drop handler per screen; it always feeds the current box.
    if (!root._drop) {
      root._drop = true;
      dropZone(root, () => C?.comp);
    }
    replace(root, wrap);
  }
  const { comp, row } = C;

  const projBtn = h('button', { class: 'cbtn', type: 'button', title: 'Project folder', 'aria-haspopup': 'menu' });
  const g = projects.find((x) => x.path === draft.project);
  projBtn.replaceChildren(icon('folder', 14), h('span', { class: 'ell' }, g ? g.name : 'Choose a folder'), icon('chevron-down', 12, 'cbtn-chev'));
  projBtn.title = g ? g.path : 'Project folder';
  projBtn.addEventListener('click', () => {
    if (!projects.length) return H.openFolder();
    const items = projects.slice(0, 12).map((x) => ({ label: x.name, hint: x.path, on: x.path === draft.project, run: () => ((draft.project = x.path), redraw()) }));
    popMenu(projBtn, [...(items.length ? [...items, '-'] : []), { label: 'Open folder…', run: () => H.openFolder() }], { minWidth: 280 });
  });

  const engSeg = ompOk
    ? h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Engine' }, [['builtin', 'ORBIX agent'], ['omp', 'OMP CLI']].map(([id, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(engine === id), title: id === 'builtin' && !agentOk ? 'Set up an AI provider first' : '', onclick: () => {
        if (engine === id) return;
        savePrefs({ defaultEngine: id });
        redraw();
      } }, label)))
    : null;

  const m = homeModel();
  const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new session', hidden: engine !== 'builtin' || !agentOk }, h('span', { class: 'cbtn-k' }, 'Model'), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default'), icon('chevron-down', 12, 'cbtn-chev'));
  modelBtn.addEventListener('click', () => modelPicker({
    load: () => loadHomeModels(draft.project),
    current: homeModel(),
    extra: 'Default model',
    onPick: (x) => {
      savePrefs({ homeModel: x ? { provider: x.provider, id: x.id, name: x.name || x.id } : null });
      redraw();
    },
  }));

  const unsaved = h('button', { class: 'cbtn on', type: 'button', title: 'This conversation will not be saved. Click to save it as usual.', hidden: !draft.ephemeral, onclick: () => ((draft.ephemeral = false), (unsaved.hidden = true)) }, h('span', null, 'Not saved'), icon('x', 12));

  // Plan first: the session starts in plan mode (reads and proposes, changes nothing), then gets the task.
  const agentRun = engine === 'builtin' && agentOk;
  const planBtn = h('button', { class: 'cbtn' + (draft.plan ? ' on' : ''), type: 'button', 'aria-pressed': String(!!draft.plan), title: 'Start in plan mode: it reads and proposes a plan, and changes nothing until you turn plan mode off', hidden: !agentRun, onclick: () => ((draft.plan = !draft.plan), redraw()) }, icon('map', 14), 'Plan first');
  const auto = S.engine?.approvals === 'auto';
  const apprBtn = h('button', { class: 'cbtn appr' + (auto ? ' off' : ''), type: 'button', title: auto ? 'Approvals are off: it edits and runs commands without asking. Click to change.' : 'Edits and commands wait for your OK. Click to change.', hidden: !agentRun, onclick: () => H.settings('behavior') }, h('span', { class: 'appr-sq', 'aria-hidden': 'true' }), auto ? 'Approvals off' : 'Asks before changes');
  const go = h('button', { class: 'send', type: 'button', title: 'Start (Enter)', 'aria-label': 'Start session', disabled: starting }, icon('send', 16));
  C.go = go;
  C.start = async () => {
    if (starting) return; // Enter twice, or Enter and a click: one session
    if (!draft.project) return H.openFolder();
    if (engine === 'builtin' && !agentOk) {
      toast('Set up an AI provider first.', 'error', 4000);
      return H.settings('engine');
    }
    const p = comp.payload();
    starting = true;
    go.disabled = true;
    comp.el.classList.add('busy');
    try {
      const mm = engine === 'builtin' ? homeModel() : null;
      await api.post('/api/workspaces', { path: draft.project }).then((r) => (S.workspaces = r.workspaces)).catch(() => {});
      const tab = await openTab({ workspace: draft.project, engine, model: mm ? `${mm.provider}/${mm.id}` : undefined, noSession: draft.ephemeral || undefined });
      draft.ephemeral = false;
      comp.reset(p?.raw);
      if (draft.plan && engine === 'builtin') await sendPrompt(tab, '/plan');
      if (p) await sendPrompt(tab, p.text || '(see the attached image)', { images: p.images });
    } catch (e) {
      toast(e.message, 'error', 8000);
    } finally {
      starting = false;
      if (C) {
        C.go.disabled = false;
        C.comp.el.classList.remove('busy');
      }
    }
  };
  go.addEventListener('click', () => C.start());

  row.replaceChildren(iconBtn('paperclip', 'Attach images or text files', () => comp.openFilePicker()), projects.length ? '' : projBtn, engSeg || '', modelBtn, planBtn, apprBtn, unsaved, h('span', { class: 'grow' }), h('span', { class: 'c-hint' }, kbd('Enter'), ' to start'), go);
  C.heroSlot.replaceChildren(hero(['What should we build', ...(g ? [' in ', h('span', { class: 'home-h-proj' }, g.name), '?'] : ['?'])], engine === 'builtin' ? (S.engine?.approvals === 'auto' ? 'It reads the project, edits files and runs commands. Approvals are off, so it does not ask first.' : 'It reads the project, edits files and runs commands, and asks before it changes anything.') : 'This session runs the OMP CLI in the project folder.'));
  C.tabsSlot.replaceChildren(...projectTabs(H, projects, () => redraw()));
  // The footer only speaks when it has something to say: no provider yet, or the OMP CLI's own setup.
  C.footSlot.replaceChildren(...(engine === 'builtin' && !agentOk ? [h('p', { class: 'home-note' }, 'Set up an AI provider to use the ORBIX agent.', h('button', { class: 'link', type: 'button', onclick: () => H.settings('engine') }, 'Set up provider'))] : engine === 'omp' ? [statusStrip(H, engine, m)] : []));
  C.lowerSlot.replaceChildren(lower(H, projects, engine));
  C.keysSlot.replaceChildren(footKeys());
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
}

/** What a new session will use: the model, whether it asks first, and where commands run. Each chip opens its setting. */
function statusStrip(H, engine, m) {
  const on = S.engine?.providers?.filter((p) => p.configured) || [];
  const cell = (k, v, title, onclick, tone) => h('button', { class: `hs-cell${tone ? ' ' + tone : ''}`, type: 'button', title, onclick }, h('span', { class: 'hs-k' }, k), h('span', { class: 'hs-v ell' }, v));
  const b = S.env?.backend;
  const auto = S.engine?.approvals === 'auto';
  const cells = [];
  if (engine === 'builtin') {
    const names = on.map((p) => p.name);
    cells.push(cell('Model', m ? m.name || m.id : names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || 'Default', names.length ? `Providers: ${names.join(', ')}. Click to change.` : 'Set up a provider', () => H.settings('engine')));
    cells.push(cell('Approvals', auto ? 'Off' : 'Ask first', auto ? 'The agent edits and runs commands without asking. Click to change.' : 'Edits and commands ask first. Click to change.', () => H.settings('behavior'), auto ? 'warn' : ''));
  } else cells.push(cell('Engine', 'OMP CLI', 'This session uses the OMP command-line agent', () => H.settings('omp')));
  if (b) cells.push(cell('Shell', b.kind === 'wsl' ? (b.distro ? `WSL · ${b.distro}` : 'WSL') : 'Windows', 'Where the agent runs commands. Click to change.', () => H.settings('behavior')));
  return h('div', { class: 'home-status' }, h('div', { class: 'hs-bar' }, ...cells));
}

/** Project tabs along the top of the launch panel: the selected one is where the task starts. */
function projectTabs(H, projects, redraw) {
  const tabs = projects.slice(0, 8).map((g) => {
    const cur = g.path === draft.project;
    // A signal only when something is happening there: teal = working, orange = waiting on you.
    const live = g.sessions.map(tabForSession).filter((t) => t && !t.dead);
    const waiting = live.some((t) => t.dialogs.some(isApproval));
    const working = live.some((t) => t.streaming);
    return h('button', { class: 'ltab' + (cur ? ' cur' : ''), type: 'button', role: 'tab', 'aria-selected': String(cur), title: g.path, onclick: () => ((draft.project = g.path), redraw()) },
      icon(cur ? 'folder-open' : 'folder', 13), h('span', { class: 'ell' }, g.name), waiting ? h('span', { class: 'dot warn', title: 'Needs you' }) : working ? h('span', { class: 'dot run', title: 'Working' }) : null);
  });
  const more = projects.length > 8 ? h('button', { class: 'ltab', type: 'button', title: 'More projects', onclick: (e) => popMenu(e.currentTarget, projects.slice(8).map((x) => ({ label: x.name, hint: x.path, run: () => ((draft.project = x.path), redraw()) })), { minWidth: 280 }) }, `+${projects.length - 8}`) : null;
  const add = h('button', { class: 'ltab add', type: 'button', title: 'Open a project folder', onclick: () => H.openFolder() }, icon('folder-plus', 13), projects.length ? null : h('span', null, 'Open a project folder'));
  return [h('div', { class: 'ltabs', role: 'tablist', 'aria-label': 'Project' }, ...tabs, more, add)];
}

/** Below the launch panel: recent conversations, and the setup checklist while anything is left to do. */
function lower(H, projects, engine) {
  const list = checklist(H, projects, engine);
  const recent = S.sessions.slice(0, list ? 5 : 6);
  const ompOk = ompInstalled();
  const rows = recent.map((s) => {
    const open = tabForSession(s);
    // State in the two signals: orange when it waits on you, teal while it works, else when it last changed.
    const waiting = open && open.dialogs.some(isApproval);
    const state = waiting ? 'wait' : open?.streaming ? 'run' : open ? 'open' : 'idle';
    return h('button', { class: `rc ${state}`, type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
      h('span', { class: 'rc-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'rc-main' }, h('span', { class: 'rc-t ell' }, s.title), h('span', { class: 'rc-f' }, h('span', { class: 'ell' }, baseName(s.cwdDisplay || s.cwd)), ompOk && s.engine !== 'builtin' ? h('span', { class: 'tag' }, 'OMP CLI') : null)),
      waiting ? h('span', { class: 'rc-pill' }, 'Waiting for your OK') : open?.streaming ? h('span', { class: 'rc-w live' }, 'working') : h('span', { class: 'rc-w num' }, open ? 'open' : timeAgo(s.mtime)));
  });
  const recentSec = rows.length ? h('section', { class: 'recent' }, h('div', { class: 'sec-h' }, h('h2', null, 'Recent'), h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage')), h('div', { class: 'rc-list' + (list ? '' : ' wide') }, ...rows)) : null;
  if (!recentSec && !list) return h('div');
  return h('div', { class: 'home-lower' + (recentSec && list ? ' two' : '') }, recentSec, list);
}

const greeting = () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

const hero = (title, sub) => h('div', { class: 'hero' },
  h('span', { class: 'home-eyebrow' }, greeting()),
  h('h1', { class: 'home-h' }, title),
  sub ? h('p', { class: 'home-sub' }, sub) : null);

/**
 * Getting set up: a short checklist read from the real state, each open step with the one action that does it.
 * It disappears once everything is done, so the home screen is just the task box for anyone already set up.
 */
function checklist(H, projects, engine) {
  const agentOk = engineReady();
  const steps = [
    { done: agentOk || engine === 'omp', t: 'Connect an AI provider', d: 'An API key or a local model. Keys are checked, then stored encrypted on this PC.', act: 'AI providers', run: () => H.settings('engine') },
    { done: projects.length > 0, t: 'Open a project folder', d: 'The agent only works inside folders you choose.', act: 'Open folder', run: () => H.openFolder() },
    { done: S.sessions.length > 0, t: 'Run your first task', d: 'Type it above and press Enter. Edits and commands ask first; every edit can be undone.' },
    { done: !!S.engine?.search?.configured, t: 'Let it search the web', d: 'Optional. Brave, Tavily or your own SearXNG gives the agent current docs and facts.', act: 'Web search', run: () => H.settings('tools') },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!left) return null;
  return h('section', { class: 'checklist', 'aria-label': 'Getting set up' },
    h('div', { class: 'sec-h' }, h('h2', null, 'Getting set up'), h('span', { class: 'sec-note num' }, `${steps.length - left} of ${steps.length} done`)),
    h('div', { class: 'cl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(steps.length - left) }, h('i', { style: { width: `${((steps.length - left) / steps.length) * 100}%` } })),
    h('ol', { class: 'cl-steps' }, steps.map((s) => h('li', { class: 'cl-step' + (s.done ? ' done' : '') },
      h('span', { class: 'cl-mark', 'aria-hidden': 'true' }, s.done ? icon('check', 12) : null),
      h('span', { class: 'cl-main' }, h('span', { class: 'cl-t' }, s.t), h('span', { class: 'cl-d' }, s.d)),
      !s.done && s.run ? h('button', { class: 'btn sm', type: 'button', onclick: s.run }, s.act) : null))));
}

const footKeys = () => h('div', { class: 'home-keys' }, [['Ctrl+K', 'commands'], ['Ctrl+N', 'new session'], ['/', 'slash commands'], ['@', 'mention a file'], ['Esc', 'stop the agent']].map(([k, l]) => h('span', null, kbd(k), ' ', l)));

function setupCard(H) {
  return h('section', { class: 'setup' },
    hero('Connect an AI provider', 'ORBIX runs on your own API key or a local model. Keys are checked with the provider and stored encrypted on this PC.'),
    h('ol', { class: 'setup-steps' },
      h('li', null, h('strong', null, 'Add a provider'), 'Anthropic, OpenAI, DeepSeek, OpenRouter, Ollama and more.'),
      h('li', { class: S.workspaces.length || S.sessions.length ? 'done' : null }, h('strong', null, 'Open a project folder'), 'The agent works only inside it.'),
      h('li', null, h('strong', null, 'Describe a task'), 'It shows every step and asks before changes.')),
    h('div', { class: 'setup-acts' }, h('button', { class: 'btn primary', type: 'button', onclick: () => H.settings('engine') }, icon('key', 14), 'Set up a provider'), h('button', { class: 'btn', type: 'button', onclick: H.diagnostics }, 'Check my setup')));
}

/** Recent conversations for the first-run screen (no provider yet). */
function recentList(H) {
  const sessions = S.sessions.slice(0, 8);
  if (!sessions.length) return null;
  return h('section', { class: 'recent' }, h('div', { class: 'sec-h' }, h('h2', null, 'Recent'), h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage')),
    h('div', { class: 'r-list' }, sessions.map((s) => h('button', { class: 'r-row', type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
      icon('message', 14), h('span', { class: 'r-t ell' }, s.title), h('span', { class: 'r-p ell' }, baseName(s.cwdDisplay || s.cwd)), h('span', { class: 'r-w' }, timeAgo(s.mtime))))));
}
