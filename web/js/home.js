// Home: a composer to start a session (project, engine, model) and the recent conversations.
// Shown when no session tab is active. With no AI provider set up it shows the first-run step instead.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd, orbit } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, defaultEngine, engineReady, ompInstalled, savePrefs, groupSessions, on } from './store.js';
import { popMenu, modelPicker } from './dialogs.js';

// The home screen is redrawn when sessions or providers change. The message box itself stays mounted (so typing,
// IME composition and the caret are never interrupted); only the parts around it are redrawn.
const draft = { draft: '', attach: [], project: '', ephemeral: false };
let models = null; // models of the configured providers, fetched once per provider change
let C = null; // the mounted home view: { wrap, comp, row, heroSlot, keysSlot, recentSlot }
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
      placeholder: 'Describe a task, for example: find why the login test fails and fix it',
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
    const projSlot = h('div');
    const recentSlot = h('div');
    const wrap = h('div', { class: 'home' }, heroSlot, comp.el, keysSlot, projSlot, recentSlot);
    C = { wrap, comp, row, heroSlot, keysSlot, projSlot, recentSlot };
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
  C.heroSlot.replaceChildren(hero('Start a task', engine === 'builtin' ? (S.engine?.approvals === 'auto' ? 'ORBIX reads your project, edits files and runs commands. Approvals are off, so it does not ask first.' : 'ORBIX reads your project, edits files and runs commands. It asks before it changes anything.') : 'This session runs the OMP CLI in your project folder.'));
  C.keysSlot.replaceChildren(!agentOk ? h('p', { class: 'home-note' }, 'The ORBIX agent needs an AI provider.', h('button', { class: 'link', type: 'button', onclick: () => H.settings('engine') }, 'Set one up')) : statusStrip(H, engine, m));
  C.projSlot.replaceChildren(projectCards(H, projects, () => redraw()));
  C.recentSlot.replaceChildren(recentList(H));
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
}

/** What a new session will use: the model, whether it asks first, and where commands run. Each chip opens its setting. */
function statusStrip(H, engine, m) {
  const on = S.engine?.providers?.filter((p) => p.configured) || [];
  const chip = (ic, text, title, onclick, tone) => h('button', { class: `hs-chip${tone ? ' ' + tone : ''}`, type: 'button', title, onclick }, icon(ic, 13), h('span', { class: 'ell' }, text));
  const b = S.env?.backend;
  const auto = S.engine?.approvals === 'auto';
  const chips = [];
  if (engine === 'builtin') {
    const names = on.map((p) => p.name);
    chips.push(chip('cpu', m ? m.name || m.id : names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] || 'Default model', names.length ? `Providers: ${names.join(', ')}` : 'Set up a provider', () => H.settings('engine')));
    chips.push(chip('shield', auto ? 'Approvals off' : 'Asks before changes', auto ? 'The agent edits and runs commands without asking. Click to change.' : 'Edits and commands ask first. Click to change.', () => H.settings('behavior'), auto ? 'warn' : ''));
  } else chips.push(chip('terminal', 'OMP CLI', 'This session uses the OMP command-line agent', () => H.settings('omp')));
  if (b) chips.push(chip('terminal', b.kind === 'wsl' ? `WSL · ${b.distro || '?'}` : 'Windows', 'Where the agent runs commands. Click to change.', () => H.settings('behavior')));
  return h('div', { class: 'home-status' }, ...chips, h('span', { class: 'hs-keys' }, kbd('Ctrl+K'), ' commands ', kbd('@'), ' files'));
}

/** Recent projects as cards: pick one to start the next session there. */
function projectCards(H, projects, redraw) {
  const head = h('div', { class: 'sec-h' }, h('h2', null, 'Projects'), h('button', { class: 'link', type: 'button', onclick: () => H.openFolder() }, 'Open folder…'));
  if (!projects.length) return h('section', { class: 'projects' }, head, h('button', { class: 'proj-card add wide', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 16), h('span', null, 'Open a project folder to start')));
  const cards = projects.slice(0, 6).map((g) => {
    const open = g.sessions.filter((x) => tabForSession(x)).length;
    const meta = g.sessions.length ? `${g.sessions.length} conversation${g.sessions.length === 1 ? '' : 's'}${g.latest ? ' · ' + timeAgo(g.latest) : ''}` : 'No conversations yet';
    return h('button', { class: 'proj-card' + (g.path === draft.project ? ' cur' : ''), type: 'button', title: g.path, 'aria-pressed': String(g.path === draft.project), onclick: () => ((draft.project = g.path), redraw()) },
      h('span', { class: 'pc-ic' }, icon('folder', 16)),
      h('span', { class: 'pc-t ell' }, g.name),
      open ? h('span', { class: 'dot open', title: `${open} open` }) : null,
      h('span', { class: 'pc-p ell' }, h('bdi', null, g.path)),
      h('span', { class: 'pc-m' }, meta));
  });
  cards.push(h('button', { class: 'proj-card add', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 16), h('span', null, 'Open folder')));
  return h('section', { class: 'projects' }, head, h('div', { class: 'proj-grid' }, ...cards));
}

const hero = (title, sub) => h('div', { class: 'hero' }, orbit(), h('h1', { class: 'home-h' }, title), sub ? h('p', { class: 'home-sub' }, sub) : null);

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
  const sessions = S.sessions.slice(0, 8);
  const head = h('div', { class: 'sec-h' }, h('h2', null, 'Recent'), sessions.length ? h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage') : null);
  if (!sessions.length) return h('section', { class: 'recent' }, head, h('p', { class: 'r-empty' }, 'Your conversations show here.'));
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
