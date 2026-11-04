// Home: a composer to start a session (project, engine, model), the projects, and the recent conversations.
// Shown when no session tab is active. With no AI provider set up it shows the first-run steps instead.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd, logo } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, defaultEngine, engineReady, ompInstalled, savePrefs, groupSessions, on } from './store.js';
import { popMenu, modelPicker } from './dialogs.js';

// The home screen is redrawn when sessions or providers change. The message box itself stays mounted (so typing,
// IME composition and the caret are never interrupted); only the parts around it are redrawn.
const draft = { draft: '', attach: [], project: '', ephemeral: false };
let models = null; // models of the configured providers, fetched once per provider change
let C = null; // the mounted home view: { wrap, comp, row, heroSlot, keysSlot, gridSlot }
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
    const heroSlot = h('div');
    const keysSlot = h('div');
    const gridSlot = h('div');
    const featSlot = h('div');
    const wrap = h('div', { class: 'home' }, heroSlot, comp.el, keysSlot, gridSlot, featSlot);
    C = { wrap, comp, row, heroSlot, keysSlot, gridSlot, featSlot };
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
  const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new session', hidden: engine !== 'builtin' || !agentOk }, icon('cpu', 14), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default model'), icon('chevron-down', 12, 'cbtn-chev'));
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

  row.replaceChildren(iconBtn('paperclip', 'Attach images or text files', () => comp.openFilePicker()), projBtn, engSeg || '', modelBtn, unsaved, h('span', { class: 'grow' }), h('span', { class: 'c-hint' }, kbd('Enter'), ' to start'), go);
  C.heroSlot.replaceChildren(hero(['What should ORBIX do', g ? h('span', { class: 'home-h-dim' }, ` in ${g.name}?`) : '?'], engine === 'builtin' ? (S.engine?.approvals === 'auto' ? 'It reads the project, edits files and runs commands. Approvals are off, so it does not ask first.' : 'It reads the project, edits files and runs commands, and asks before it changes anything.') : 'This session runs the OMP CLI in the project folder.'));
  C.keysSlot.replaceChildren(engine === 'builtin' && !agentOk ? h('p', { class: 'home-note' }, 'Set up an AI provider to use the ORBIX agent.', h('button', { class: 'link', type: 'button', onclick: () => H.settings('engine') }, 'Set up provider')) : statusStrip(H, engine, m));
  const recent = recentList(H);
  C.gridSlot.replaceChildren(h('div', { class: 'home-grid' + (recent ? '' : ' one') }, projectList(H, projects, () => redraw()), recent));
  C.featSlot.replaceChildren(features(H, comp, engine));
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
  if (b) cells.push(cell('Shell', b.kind === 'wsl' ? `WSL · ${b.distro || '?'}` : 'Windows', 'Where the agent runs commands. Click to change.', () => H.settings('behavior')));
  return h('div', { class: 'home-status' }, h('div', { class: 'hs-bar' }, ...cells), h('span', { class: 'hs-keys' }, kbd('Ctrl+K'), ' commands  ', kbd('@'), ' files'));
}

/** Projects as a list: pick one to start the next session there. */
function projectList(H, projects, redraw) {
  const head = h('div', { class: 'sec-h' }, h('h2', null, 'Projects'), h('button', { class: 'link', type: 'button', onclick: () => H.openFolder() }, 'Open folder…'));
  const rows = projects.slice(0, 8).map((g) => {
    const cur = g.path === draft.project;
    const open = g.sessions.filter((x) => tabForSession(x)).length;
    const meta = open ? `${open} open` : g.sessions.length ? `${g.sessions.length} chat${g.sessions.length === 1 ? '' : 's'}` : 'new';
    return h('button', { class: 'p-row' + (cur ? ' cur' : ''), type: 'button', title: g.path, 'aria-pressed': String(cur), onclick: () => ((draft.project = g.path), redraw()) },
      icon(cur ? 'folder-open' : 'folder', 15),
      h('div', { class: 'p-main' }, h('span', { class: 'p-name ell' }, g.name, open ? h('span', { class: 'dot open' }) : null), h('span', { class: 'p-path ell' }, h('bdi', null, g.path))),
      h('span', { class: 'p-meta' }, meta));
  });
  if (!rows.length) rows.push(h('button', { class: 'p-row p-add', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 15), h('div', { class: 'p-main' }, h('span', { class: 'p-name' }, 'Open a project folder'), h('span', { class: 'p-path' }, 'ORBIX works only inside folders you choose.'))));
  return h('section', { class: 'projects' }, head, h('div', { class: 'p-list' }, ...rows));
}

const hero = (title, sub) => h('div', { class: 'hero' }, h('div', { class: 'home-mark', 'aria-hidden': 'true' }, logo(56)), h('div', { class: 'hero-t' }, h('h1', { class: 'home-h' }, title), sub ? h('p', { class: 'home-sub' }, sub) : null));

/**
 * What ORBIX can do, each with the one action that uses it. Only real, shipped features; each card does something.
 * Slash commands go into the task box (they run once a session starts); the rest open their setting.
 */
function features(H, comp, engine) {
  const put = (text) => () => {
    comp.ta.value = text;
    comp.ta.dispatchEvent(new Event('input', { bubbles: true }));
    comp.focus();
  };
  const agent = engine === 'builtin';
  const items = [
    ['shield', 'Asks before it acts', 'Edits and commands wait for your OK: 1 allow once, 2 for the session, Esc deny.', 'Approval settings', () => H.settings('behavior')],
    ['undo', 'Undo any change', 'Every file edit has its own Undo, and /undo reverts the whole last reply.', null, null],
    ['map', 'Plan first', 'The Plan button (or /plan) makes it read and propose a plan. Nothing on disk changes until you turn it off.', null, null],
    ['users', 'Helper agents', 'Read-only helpers research in parallel and report back. Watch them in the Agents panel.', null, null],
    ['key', '17 providers', 'Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, local Ollama and LM Studio. Keys stay encrypted on this PC.', 'AI providers', () => H.settings('engine')],
    ['plug', 'MCP, skills, hooks', 'Add tools with MCP servers, teach it with SKILL.md files, guard it with your own hooks.', 'Tools & MCP', () => H.settings('tools')],
    ['branch', 'Git built in', 'See, stage, discard and commit changes in the side panel. /review checks them for bugs.', agent ? 'Review my changes' : null, agent ? put('/review') : null],
    ['terminal', ompInstalled() ? 'OMP CLI ready' : 'Windows or WSL', ompInstalled() ? 'Run a session with the OMP CLI instead of the built-in agent, with its own sign-ins.' : 'Commands run in PowerShell on Windows or inside a WSL distribution.', ompInstalled() ? 'OMP CLI settings' : 'Where commands run', () => H.settings(ompInstalled() ? 'omp' : 'behavior')],
  ];
  return h('section', { class: 'features', 'aria-label': 'What ORBIX can do' },
    h('div', { class: 'sec-h' }, h('h2', null, 'What it can do'), h('span', { class: 'sec-note' }, kbd('/'), ' for every command')),
    h('div', { class: 'feat-grid' }, items.map(([ic, t, d, act, run]) => {
      const card = h(run ? 'button' : 'div', { class: 'feat' + (run ? ' act' : ''), type: run ? 'button' : null, onclick: run || null },
        h('span', { class: 'feat-ic' }, icon(ic, 16)),
        h('span', { class: 'feat-t' }, t),
        h('span', { class: 'feat-d' }, d),
        act ? h('span', { class: 'feat-a' }, act, icon('chevron-right', 12)) : null);
      return card;
    })));
}

function setupCard(H) {
  return h('section', { class: 'setup' },
    hero('Connect an AI provider', 'ORBIX runs on your own API key or a local model. Keys are checked with the provider and stored encrypted on this PC.'),
    h('ol', { class: 'setup-steps' },
      h('li', null, h('strong', null, 'Add a provider'), 'Anthropic, OpenAI, DeepSeek, OpenRouter, Ollama and more.'),
      h('li', { class: S.workspaces.length || S.sessions.length ? 'done' : null }, h('strong', null, 'Open a project folder'), 'The agent works only inside it.'),
      h('li', null, h('strong', null, 'Describe a task'), 'It shows every step and asks before changes.')),
    h('div', { class: 'setup-acts' }, h('button', { class: 'btn primary', type: 'button', onclick: () => H.settings('engine') }, icon('key', 14), 'Set up a provider'), h('button', { class: 'btn', type: 'button', onclick: H.diagnostics }, 'Check my setup')));
}

function recentList(H) {
  const sessions = S.sessions.slice(0, 10);
  if (!sessions.length) return null;
  const head = h('div', { class: 'sec-h' }, h('h2', null, 'Recent'), h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage'));
  const ompOk = ompInstalled();
  return h('section', { class: 'recent' }, head,
    h('div', { class: 'r-list' }, sessions.map((s) => {
      const open = tabForSession(s);
      return h('button', { class: 'r-row', type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
        icon('message', 14),
        h('span', { class: 'r-t ell' }, s.title),
        ompOk && s.engine !== 'builtin' ? h('span', { class: 'tag' }, 'OMP CLI') : null,
        h('span', { class: 'r-p ell' }, baseName(s.cwdDisplay || s.cwd)),
        h('span', { class: 'r-w' }, open ? h('span', { class: 'dot' + (open.streaming ? ' run' : ' open'), title: open.streaming ? 'Working' : 'Open' }) : timeAgo(s.mtime)));
    })));
}
