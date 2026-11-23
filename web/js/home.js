// Home: one centred stack. The ORBIX mark (48px, muted) and one line, "Where should we pick up?"; what needs you; three
// suggestions as rows; the project and where it works (the project folder or a separate branch) as chips on top of the
// message box; then the project's latest conversations. No cards.
// Conversations and projects are in the sidebar. Before a model or a project is connected, Home offers setup.
import { addContext, permissionChip, modelLabel, effortChip } from './controls.js';
import { runInTerminal } from './terminal.js';
import { h, icon, iconBtn, replace, baseName, toast, logo, timeAgo } from './dom.js';
import { Composer, ASK, dropZone } from './composer.js';
import { api } from './api.js';
import { S, openTab, sendPrompt, setThinking, tabForSession, engineReady, savePrefs, groupSessions, on, emit, setActive } from './store.js';
import { popMenu, modelPicker, isApproval, thinkingLevels } from './dialogs.js';
import { brandTile } from './brands.js';
import { taskButtons, projectTasks } from './workspace.js';
import { branchToggle } from './review.js';

// The home screen is redrawn when sessions or providers change. The message box stays mounted (so typing, IME
// composition and the caret are never interrupted); only the parts around it are redrawn.
const DRAFT_KEY = 'orbix-home-draft';
function recoveredDraft() {
  try { const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); return typeof d?.text === 'string' && d.text.length <= 100000 ? d : null; } catch { return null; }
}
const recovered = recoveredDraft();
const draft = { draft: recovered?.text || '', attach: [], project: recovered?.project || '', ephemeral: false };
let saveDraftTimer = 0;
function persistDraft() {
  clearTimeout(saveDraftTimer);
  try {
    if (!draft.ephemeral && draft.draft.trim() && draft.draft.length <= 100000) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ text: draft.draft, project: draft.project }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch { /* Storage restrictions must never interrupt typing or sending. */ }
}
addEventListener('pagehide', persistDraft);
let modelList = null;
let W = null; // the mounted page: its persistent slots
let C = null; // the mounted task box: { comp, el, row, go, start }
let starting = false;
on('engine', () => (modelList = null));
// Git was just set up in a folder (the side panel or the project menu): Home reads its working tree again.
let drawLast = null;
on('git:init', (ws) => {
  if (!W || W.statusPath !== ws) return;
  W.statusPath = undefined;
  W.sugFor = undefined;
  drawLast?.();
});

/** The project chosen on Home, for pages that need one while no session is open. */
export const homeProject = () => draft.project || '';
let panelFor = null;

export function setHomeProject(path, { ephemeral } = {}) {
  if (path) draft.project = path;
  if (ephemeral != null) draft.ephemeral = ephemeral;
  if (draft.ephemeral) { clearTimeout(saveDraftTimer); try { sessionStorage.removeItem(DRAFT_KEY); } catch {} }
}

/** The saved model choice for new sessions, if its provider is still set up. */
function homeModel() {
  const m = S.ui.homeModel;
  if (!m?.provider || !m.id) return null;
  return S.engine?.providers?.some((p) => p.id === m.provider && p.configured) || S.engine?.agents?.some((a) => a.id === m.provider && a.installed) ? m : null;
}

/** List models directly, without starting a temporary conversation or requiring a project. */
function loadHomeModels() {
  if (modelList && Date.now() < modelList.until) return modelList.promise;
  const entry = { until: Infinity };
  entry.promise = api.get('/api/engine/models').then((result) => {
    entry.until = Date.now() + (result.errors?.length ? 0 : 30000);
    return result;
  }, (e) => {
    if (modelList === entry) modelList = null;
    throw e;
  });
  modelList = entry;
  return entry.promise;
}

/** Add `text` to Home's message box (a skill from the Context menu, a file from the side panel). */
export function insertHome(text) {
  if (!C) return;
  const v = C.comp.value;
  C.comp.value = v + (v && !/\s$/.test(v) ? ' ' : '') + text;
  C.comp.focus();
}

/** The reasoning levels of model `m`, from the loaded model list (null until it has loaded). */
let modelRows = null;
function levelsOf(m) {
  if (!modelRows) return null;
  return thinkingLevels(modelRows.find((x) => x.provider === m.provider && x.id === m.id));
}
async function loadLevels(m) {
  const r = await loadHomeModels();
  modelRows = Array.isArray(r) ? r : r?.models || [];
  return levelsOf(m) || [];
}

/** The page's skeleton, built once per mount. */
function shell(root) {
  if (W && root.contains(W.wrap)) return W;
  const title = h('h1', { class: 'home-title' });
  const sub = h('p', { class: 'home-sub' });
  const alertSlot = h('div', { class: 'home-alerts' });
  const stepsSlot = h('div', { class: 'home-steps-slot' });
  const deckSlot = h('div', { class: 'home-deck' });
  const under = h('div', { class: 'home-under' });
  const statusSlot = h('div', { class: 'home-status-slot' });
  const recentSlot = h('div', { class: 'home-recent-slot' });
  const hero = h('section', { class: 'home-hero', 'aria-label': 'ORBIX' }, h('span', { class: 'home-mark', 'aria-hidden': 'true' }, logo(48)), h('header', { class: 'home-head' }, title, sub));
  // Top to bottom: what needs you, the suggestions, the project chips and the message box, the latest conversations.
  const dock = h('section', { class: 'home-dock', 'aria-label': 'New task' }, alertSlot, stepsSlot, under, deckSlot, recentSlot);
  const wrap = h('div', { class: 'home' }, hero, dock);
  W = { wrap, title, sub, alertSlot, stepsSlot, deckSlot, under, statusSlot, recentSlot };
  // One drop handler per screen; it always feeds the current box.
  if (!root._drop) {
    root._drop = true;
    dropZone(root, () => C?.comp);
  }
  replace(root, wrap);
  return W;
}

/** Mount the task box once, so a redraw never touches what is being typed. */
function deck() {
  if (C) return C;
  const comp = new Composer({
    placeholder: ASK,
    label: 'Task for the new conversation',
    cls: 'home-composer',
    state: draft,
    workspace: () => draft.project,
    onSubmit: () => C?.start(),
    onChange: () => {
      clearTimeout(saveDraftTimer); saveDraftTimer = setTimeout(persistDraft, 250);
    },
  });
  const row = h('div', { class: 'c-row' });
  comp.el.append(row);
  // On top of the box, chips: the project, where the conversation works, and the working tree.
  const head = h('div', { class: 'home-box-h' });
  C = { comp, row, head, el: h('div', { class: 'home-box' }, head, comp.el) };
  return C;
}

function updateStart(box) {
  const label = starting ? 'Starting…' : !draft.project ? 'Open folder' : !engineReady() ? 'Connect a model' : 'Start';
  box.go.disabled = starting;
  // Ready: a round send button, as in a conversation. Otherwise the button says what comes first.
  box.go.classList.toggle('text', label !== 'Start');
  box.go.replaceChildren(label === 'Start' ? icon('send', 15) : label);
  box.go.setAttribute('aria-label', label);
  box.go.title = label === 'Start' ? 'Start (Enter)' : label;
  box.comp.el.classList.toggle('busy', starting);
}

// A control is found again after a redraw by its classes and tooltip, so the focus stays on it (the model button
// keeps the focus while the model list loads and Home redraws its row).
const keyOf = (el) => (el?.classList?.length ? [...el.classList].map((c) => '.' + CSS.escape(c)).join('') + (el.title ? `[title="${CSS.escape(el.title)}"]` : '') : '');
export function drawHome(root, H) {
  const focusKey = root.contains(document.activeElement) && document.activeElement !== root ? keyOf(document.activeElement) : '';
  const agentOk = engineReady();
  const w = shell(root);
  drawLast = () => !root.hidden && drawHome(root, H);
  const redraw = () => {
    drawHome(root, H);
    C?.comp.focus();
  };
  const projects = groupSessions().filter((g) => g.path);
  if (!projects.some((g) => g.path === draft.project)) draft.project = projects[0]?.path || '';
  const g = projects.find((x) => x.path === draft.project);
  const history = S.sessions.length > 0;

  const setupOnly = !agentOk && !history && !projects.length;
  w.wrap.classList.toggle('first', setupOnly);
  drawHead(w, agentOk, g);
  drawProjectStatus(w, g, () => { if (!root.hidden) drawHome(root, H); });
  w.alertSlot.replaceChildren(...attention(H));
  w.stepsSlot.replaceChildren(checklist(H, projects) || '');

  if (setupOnly) {
    // First run: one welcome and one next step. Lists wait until there is something to list.
    if (C?.el.isConnected) C.el.remove();
    const deckSig = 'deck:' + JSON.stringify((S.engine?.providers || []).map((p) => [p.id, p.configured]));
    if (w.deckSig !== deckSig || !w.deckSlot.querySelector('.home-connect')) {
      w.deckSig = deckSig;
      const deckEl = connectDeck(H);
      w.deckSlot.replaceChildren(deckEl);
    }
    w.under.replaceChildren();
    return;
  }
  w.deckSig = null;

  const box = deck();
  const { comp, row } = box;
  if (box.el.parentNode !== w.deckSlot) w.deckSlot.replaceChildren(box.el);

  const controlsSig = JSON.stringify([draft.project, !!draft.plan, !!draft.ephemeral, !!draft.branch, w.statusRepo, agentOk, S.engine?.approvals, homeModel(), S.ui.homeThinking, S.ui.effortDisplay, projects.map(p => [p.path, p.name])]);
  if (box.controlsSig !== controlsSig) {
    box.controlsSig = controlsSig;
    const projBtn = h('button', { class: 'hb-btn proj-pick' + (g ? '' : ' need'), type: 'button', title: g ? g.path : 'Choose a project folder', 'aria-haspopup': 'menu' }, icon('folder', 13), h('span', { class: 'ell' }, g ? g.name : 'Choose a folder'), icon('chevron-down', 11, 'cbtn-chev'));
    projBtn.addEventListener('click', () => {
      if (!projects.length) return H.openFolder();
      const last = (x) => Math.max(0, ...x.sessions.map((q) => q.mtime || 0));
      const items = [...projects].sort((a, b) => last(b) - last(a)).slice(0, 8).map((x) => ({ icon: 'folder', label: x.name, hint: x.path, on: x.path === draft.project, run: () => ((draft.project = x.path), redraw()) }));
      popMenu(projBtn, [{ header: 'Recent' }, ...items, '-', { icon: 'folder-plus', label: 'Open a folder…', run: () => H.openFolder() }, projects.length > 8 ? { icon: 'list', label: 'All projects…', run: () => H.settings('projects') } : null].filter(Boolean), { minWidth: 280 });
    });

    const m = homeModel();
    const modelBtn = h('button', { class: 'cbtn home-model-pick', type: 'button', title: 'Model for the new conversation', 'aria-haspopup': 'dialog' }, ...modelLabel(m));
    // The reasoning level for the new conversation, when the chosen model has levels (its default until you pick).
    const effort = effortChip((level) => (savePrefs({ homeThinking: level }), redraw()));
    const lv = m && levelsOf(m);
    const meta = () => ({ model: m?.name || m?.id, def: modelRows?.find((x) => x.provider === m?.provider && x.id === m?.id)?.thinking?.default });
    if (lv || !m) effort.update(lv || [], S.ui.homeThinking || '', meta());
    else if (engineReady()) loadLevels(m).then((x) => effort.update(x, S.ui.homeThinking || '', meta())).catch(() => {});
    modelBtn.addEventListener('click', () => !engineReady() ? H.settings('engine') : modelPicker({
      anchor: modelBtn,
      load: loadHomeModels,
      returnFocus: () => row.querySelector('.home-model-pick'),
      loading: 'Loading models from your providers…',
      current: homeModel(),
      thinking: true,
      level: S.ui.homeThinking || '',
      extra: 'Default: your saved default model, or the first one listed',
      onPick: (x, level) => {
        const same = x && homeModel() && homeModel().provider === x.provider && homeModel().id === x.id;
        savePrefs({ homeModel: x ? { provider: x.provider, id: x.id, name: x.name || x.id } : null, homeThinking: level || (same ? S.ui.homeThinking || null : null) });
        redraw();
      },
    }));

    const unsaved = h('button', { class: 'cbtn on', type: 'button', title: 'This conversation will not be saved. Click to save it as usual.', hidden: !draft.ephemeral, onclick: () => ((draft.ephemeral = false), (unsaved.hidden = true)) }, h('span', null, 'Not saved'), icon('x', 12));

    // Plan first: the session starts in plan mode (reads and proposes, changes nothing), then gets the task.
    // Plan first: one toggle, as in a conversation's box. On, the agent reads and proposes a plan and changes nothing.
    const modes = h('button', { class: 'cbtn plan-pick' + (draft.plan ? ' on' : ''), type: 'button', 'aria-pressed': String(!!draft.plan), title: draft.plan ? 'Plan first: it reads and proposes a plan, and changes nothing until you say go' : 'Plan first: off. It edits files and runs commands as your permissions allow', onclick: () => {
      draft.plan = !draft.plan;
      redraw();
    } }, icon('map', 14), h('span', null, 'Plan'));
    const apprBtn = permissionChip().el;
    const go = h('button', { class: 'send start', type: 'button' });
    box.go = go;
    updateStart(box);
    box.start = async () => {
      if (starting) return; // Enter twice, or Enter and a click: one session
      if (!draft.project) return H.openFolder();
      // !command: a shell command, run in the project's Terminal (the side panel), not a new conversation.
      const bang = /^!\s*(\S[\s\S]*)/.exec(comp.value.trim());
      if (bang && !draft.attach?.length) {
        comp.reset(comp.value.trim());
        persistDraft();
        return runInTerminal(bang[1].trim());
      }
      if (!engineReady()) {
        toast('Connect a model first.', 'error', 4000);
        return H.settings('engine');
      }
      const p = comp.payload();
      const workspace = draft.project;
      const { plan, ephemeral, branch } = draft;
      const mm = homeModel();
      starting = true;
      updateStart(box);
      try {
        // Remembered in the project list alongside the start, not before it (it is not needed to start).
        api.post('/api/workspaces', { path: workspace }).then((r) => (S.workspaces = r.workspaces)).catch(() => {});
        const tab = await openTab({ workspace, model: mm ? `${mm.provider}/${mm.id}` : undefined, noSession: ephemeral || undefined, branch: !!branch });
        if (draft.project === workspace) draft.ephemeral = false;
        comp.reset(p?.raw);
        persistDraft();
        if (S.ui.homeThinking && mm) await setThinking(tab, S.ui.homeThinking).catch(() => {});
        if (plan) await sendPrompt(tab, '/plan');
        if (p) await sendPrompt(tab, p.text || '(see the attached image)', { images: p.images });
      } catch (e) {
        if (p && !comp.hasContent()) { comp.restore(p); persistDraft(); }
        toast(e.message, 'error', 8000);
      } finally {
        starting = false;
        updateStart(box);
      }
    };
    go.addEventListener('click', () => box.start());

    const branchBtn = branchToggle(draft, w.statusRepo, () => drawHome(root, H));
    box.head.replaceChildren(projBtn, branchBtn || '', h('span', { class: 'grow' }), w.statusSlot);
    row.replaceChildren(addContext(comp), modelBtn, effort.el, modes, unsaved, h('span', { class: 'grow' }), apprBtn, go);
  }
  drawSuggestions(w, comp, g);
  drawRecent(w, g, H);
  // The side panel on Home works for the chosen project: tell it when that changes.
  if (panelFor !== draft.project) {
    panelFor = draft.project;
    emit('home:project');
  }
  const active = document.activeElement;
  const again = focusKey && (!active || active === document.body || !active.isConnected) ? root.querySelector(focusKey) : null;
  if (again) again.focus({ preventScroll: true });
  else if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
}

/** The chosen project's latest conversations, by day: Today, Yesterday, Earlier (eight at most). */
function drawRecent(w, g, H) {
  const list = (g?.sessions || []).filter((s) => !(S.ui.archived || []).includes(s.path)).sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  if (!list.length) return replace(w.recentSlot);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = (ms) => (ms >= start.getTime() ? 'Today' : ms >= start.getTime() - 86400000 ? 'Yesterday' : 'Earlier');
  const groups = [];
  for (const s of list) {
    const k = day(s.mtime);
    if (groups.at(-1)?.[0] !== k) groups.push([k, []]);
    groups.at(-1)[1].push(s);
  }
  replace(w.recentSlot, h('section', { class: 'home-recent', 'aria-label': `Recent in ${g.name}` },
    groups.map(([k, rows]) => h('div', { class: 'hr-group' },
      h('div', { class: 'hr-h' }, k),
      rows.map((s) => h('button', { class: 'hr-row', type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
        h('span', { class: 'ell grow' }, s.title),
        h('span', { class: 'hr-when num' }, timeAgo(s.mtime))))))));
}

/**
 * Three suggestions for the chosen project, from what is in its folder: an empty folder gets "Start a project", one
 * with uncommitted changes "Review my changes", one with a build file "Run the tests", one without a README "Write a
 * README". Read once per project; nothing is sent.
 */
function drawSuggestions(w, comp, project) {
  if (w.sugFor === (project?.path || '') && w.sugComp === comp) return;
  w.sugFor = project?.path || '';
  w.sugComp = comp;
  if (!project) return void w.under.replaceChildren();
  const p = encodeURIComponent(project.path);
  Promise.all([
    api.get(`/api/fs/list?path=${p}`).then((r) => r.listing?.entries || []).catch(() => [{ name: 'readme.md' }]),
    api.get(`/api/git/status?ws=${p}`).then((r) => !!r.git?.files?.length).catch(() => false),
  ]).then(([entries, changed]) => {
    if (w.sugFor !== project.path) return; // another project was chosen meanwhile
    w.under.replaceChildren(h('div', { class: 'ws-recipes', role: 'group', 'aria-label': 'Suggested tasks' }, taskButtons(comp, projectTasks(entries, { changed }).slice(0, 3), 'ws-recipe')));
  });
}

/** The one line for an open project; otherwise the next setup step. */
function drawHead(w, ready, project) {
  const text = project && ready ? 'Where should we pick up?' : ready ? 'Open a project folder' : 'Connect a model';
  if (w.title.textContent !== text) w.title.textContent = text;
  const sub = project ? '' : ready ? 'The agent works only inside a folder you choose.' : 'Add an API key, sign in, or use a model that runs on this PC. You can change it at any time.';
  if (w.sub.textContent !== sub) w.sub.textContent = sub;
  w.sub.hidden = !sub;
}

/** A local snapshot, available even without a model. Nothing is sent or changed. */
function drawProjectStatus(w, project, redrawControls) {
  if (w.statusPath === project?.path) return;
  w.statusPath = project?.path;
  w.statusRepo = null;
  draft.branch = false;
  if (!project) {
    w.statusSlot.replaceChildren();
    return;
  }
  const details = h('div', { class: 'home-status-details', role: 'status' });
  let loading = false;
  const refresh = iconBtn('refresh', 'Refresh working tree', () => load());
  const row = h('div', { class: 'home-status', role: 'group', 'aria-label': 'Working tree' }, details, refresh);
  w.statusSlot.replaceChildren(row);

  async function load() {
    if (loading) return;
    loading = true;
    refresh.setAttribute('aria-disabled', 'true');
    details.textContent = 'Checking working tree…';
    try {
      const { git } = await api.get(`/api/git/status?ws=${encodeURIComponent(project.path)}`);
      if (!row.isConnected) return;
      w.statusRepo = !!git?.repo;
      if (!git?.repo) {
        draft.branch = false;
        // A folder without git has no working tree to show: the line stays empty, with no refresh button.
        details.replaceChildren();
        refresh.hidden = true;
        if (git?.gitMissing) details.textContent = 'Git isn’t installed';
      } else {
        refresh.hidden = false;
        const branch = git.branch?.startsWith('HEAD (') ? 'Detached HEAD' : git.branch || 'No branch';
        const count = git.files.length;
        details.replaceChildren(
          icon('branch', 14),
          h('span', { class: 'ell', title: branch }, branch),
          h('span', { class: 'home-status-summary' }, count ? `${count} changed ${count === 1 ? 'file' : 'files'}` : 'Working tree clean'),
        );
      }
    } catch (e) {
      if (!row.isConnected) return;
      w.statusRepo = false;
      draft.branch = false;
      details.replaceChildren(h('span', { class: 'ell', title: e.message }, 'Couldn’t read the working tree'));
    } finally {
      loading = false;
      refresh.removeAttribute('aria-disabled');
      if (row.isConnected) redrawControls();
    }
  }
  load();
}

/** Sessions working or waiting on you, above everything else: this is what you came back for. */
function attention(H) {
  const { waiting, working } = liveTabs();
  return [...waiting, ...working.filter((t) => !waiting.includes(t))].slice(0, 3).map((t) => {
    const wait = waiting.includes(t);
    const s = S.sessions.find((x) => tabForSession(x) === t);
    return h('button', { class: `home-alert ${wait ? 'wait' : 'run'}`, type: 'button', onclick: () => (s ? H.openSession(s) : setActive(t.id)) },
      h('span', { class: 'dot ' + (wait ? 'warn' : 'run') }),
      h('span', { class: 'home-alert-t ell' }, s?.title || t.name || 'Conversation'),
      h('span', { class: 'home-alert-p ell' }, baseName(t.workspace || '')),
      h('span', { class: 'home-alert-s' }, wait ? 'Needs your OK' : 'Working'),
      icon('chevron-right', 14));
  });
}

/** What is still needed before the first task. Optional extras live in Settings, not here. */
function checklist(H, projects) {
  const steps = [
    { done: engineReady(), t: 'Connect a model', run: () => H.settings('engine') },
    { done: projects.length > 0, t: 'Open a folder', run: () => H.openFolder() },
    { done: S.sessions.length > 0, t: 'Run a task' },
  ];
  const left = steps.filter((s) => !s.done).length;
  // With a model and a folder, the task box itself is the next step.
  if (steps[0].done && steps[1].done) return null;
  // A step still to do is one button (number, label, arrow); a done step is a quiet line with a check.
  return h('ol', { class: 'home-steps', 'aria-label': `Setup: ${steps.length - left} of ${steps.length} done` }, steps.map((s, i) => {
    const n = h('span', { class: 'home-step-n', 'aria-hidden': 'true' }, s.done ? icon('check', 12) : String(i + 1));
    const label = h('span', { class: 'ell' }, s.t);
    const act = !s.done && s.run;
    return h('li', { class: 'home-step' + (s.done ? ' done' : '') + (act ? ' act' : '') },
      act ? h('button', { class: 'home-step-b', type: 'button', onclick: s.run }, n, label, icon('arrow-right', 14)) : [n, label]);
  }));
}

// ================= first run =================

/** The providers on the first screen, one row each; a click opens Settings on that provider's form. */
// The first-run deck: one row per maker. OpenAI's row covers the ChatGPT plan and the API key, and opens on the plan sign-in.
const PV_SUB = { anthropic: 'Claude models', chatgpt: 'Your ChatGPT plan or an API key', google: 'Gemini models', xai: 'Grok models', openrouter: 'Models from many providers, one key', ollama: 'Free models on this PC', lmstudio: 'Models from the LM Studio app' };
const PV_HOW = { anthropic: 'API key', chatgpt: 'Sign in', google: 'API key', xai: 'Sign in', openrouter: 'Sign in', ollama: 'No key', lmstudio: 'No key' };
const PV_NAME = { chatgpt: 'OpenAI' };
function focusProvider(H, id) {
  H.connect();
  const t0 = Date.now();
  const sel = `.pv-card[data-ids~="${CSS.escape(id)}"]`;
  const tick = () => {
    const card = document.querySelector(sel);
    if (card) {
      if (!card.classList.contains('open')) card.querySelector('.pv-head')?.click();
      const open = document.querySelector(sel);
      open.scrollIntoView({ block: 'center' });
      open.classList.add('flash');
      (open.querySelector(`.pv-way[data-id="${CSS.escape(id)}"]`) || open).querySelector('.pv-oauth .btn, .pv-key, .pv-url, .pv-form .btn')?.focus({ preventScroll: true });
    } else if (Date.now() - t0 < 3000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function connectDeck(H) {
  const all = S.engine?.providers || [];
  const on = (p) => p.configured || (p.id === 'chatgpt' && all.some((q) => q.id === 'openai' && q.configured));
  const rows = all.filter((p) => p.id in PV_SUB).map((p) => h('li', null, h('button', { class: 'cx-row' + (on(p) ? ' on' : ''), type: 'button', title: `Connect ${PV_NAME[p.id] || p.name}`, onclick: () => focusProvider(H, p.id) },
    brandTile(p.id, 30, 'cx-ic'),
    h('span', { class: 'cx-n' }, PV_NAME[p.id] || p.name),
    h('span', { class: 'cx-s' }, PV_SUB[p.id]),
    h('span', { class: 'cx-how' }, on(p) ? 'Connected' : PV_HOW[p.id]))));
  return h('section', { class: 'home-connect', 'aria-label': 'Connect a model' },
    rows.length ? h('ul', { class: 'cx-list' }, ...rows) : h('p', { class: 'home-none' }, 'Choose a provider in Settings to connect your first model.'),
    h('div', { class: 'connect-foot' },
      h('span', { class: 'connect-acts' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => H.connect() }, 'All providers and agents'), h('button', { class: 'btn ghost sm', type: 'button', onclick: H.diagnostics }, 'Check my setup')),
      h('p', { class: 'setup-note' }, 'Keys are stored encrypted on this PC.')));
}

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}
