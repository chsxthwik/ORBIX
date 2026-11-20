// Home: start the next task, or get back to one. One message box, then what needs you, recent conversations and projects.
// Before a project or model is connected, Home offers provider setup.
import { addContext, permissionChip } from './controls.js';
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, engineReady, savePrefs, groupSessions, on, setActive } from './store.js';
import { popMenu, modelPicker, isApproval } from './dialogs.js';
import { brandMark } from './brands.js';
import { recipes } from './workspace.js';
import { sessionLibrary } from './session-library.js';
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
let models = null; // models of the configured providers, fetched once per provider change
let W = null; // the mounted page: its persistent slots
let C = null; // the mounted task box: { comp, el, row, go, start }
let starting = false;
on('engine', () => (models = null));

/** The project chosen on Home, for pages that need one while no session is open. */
export const homeProject = () => draft.project || '';

export function setHomeProject(path, { ephemeral } = {}) {
  if (path) draft.project = path;
  if (ephemeral != null) draft.ephemeral = ephemeral;
  if (draft.ephemeral) { clearTimeout(saveDraftTimer); try { sessionStorage.removeItem(DRAFT_KEY); } catch {} }
}

/** The saved model choice for new sessions, if its provider is still set up. */
function homeModel() {
  const m = S.ui.homeModel;
  if (!m?.provider || !m.id) return null;
  return S.engine?.providers?.some((p) => p.id === m.provider && p.configured) ? m : null;
}

/** Model list without an open session: borrow a running tab, or ask a short-lived unsaved one. */
async function loadHomeModels(workspace) {
  if (models) return models;
  const tab = [...S.tabs.values()].find((t) => !t.dead && t.ready);
  if (tab) {
    models = tab.models || (await rpc(tab.id, { type: 'get_available_models' })).data.models || [];
    return models;
  }
  if (!workspace) throw new Error('Choose a project folder first.');
  const j = await api.post('/api/proc/start', { workspace, noSession: true });
  try {
    models = (await rpc(j.id, { type: 'get_available_models' })).data.models || [];
  } finally {
    api.post('/api/proc/stop', { proc: j.id }).catch(() => {});
  }
  return models;
}

/** The page's skeleton, built once per mount. */
function shell(root) {
  if (W && root.contains(W.wrap)) return W;
  const title = h('h1', { class: 'home-title' });
  const sub = h('p', { class: 'home-sub' });
  const alertSlot = h('div', { class: 'home-alerts' });
  const deckSlot = h('div', { class: 'home-deck' });
  const under = h('div', { class: 'home-under' });
  const statusSlot = h('div', { class: 'home-status-slot' });
  const hero = h('section', { class: 'home-hero', 'aria-label': 'New task' }, h('header', { class: 'home-head' }, title, sub), alertSlot, deckSlot, statusSlot, under);
  const boardSlot = h('div', { class: 'home-board-slot' });
  const keysSlot = h('div', { class: 'home-keys-slot' });
  const wrap = h('div', { class: 'home' }, hero, boardSlot, keysSlot);
  W = { wrap, title, sub, alertSlot, deckSlot, under, statusSlot, boardSlot, keysSlot };
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
    placeholder: 'Ask anything, @ to mention, / for actions',
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
  C = { comp, row, el: comp.el };
  return C;
}

function updateStart(box) {
  const label = starting ? 'Starting…' : !draft.project ? 'Open folder' : !engineReady() ? 'Connect a model' : 'Start';
  box.go.disabled = starting;
  box.go.textContent = label;
  box.go.setAttribute('aria-label', label === 'Start' ? 'Start' : label);
  box.go.title = label === 'Start' ? 'Start (Enter)' : label;
  box.el.classList.toggle('busy', starting);
}

export function drawHome(root, H) {
  const agentOk = engineReady();
  const w = shell(root);
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
  w.keysSlot.replaceChildren(footKeys());
  w.alertSlot.replaceChildren(...attention(H));

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
    w.boardSig = null;
    w.boardSlot.replaceChildren();
    return;
  }
  w.deckSig = null;

  const box = deck();
  const { comp, row } = box;
  if (box.el.parentNode !== w.deckSlot) w.deckSlot.replaceChildren(box.el);

  const controlsSig = JSON.stringify([draft.project, !!draft.plan, !!draft.ephemeral, !!draft.branch, w.statusRepo, agentOk, S.engine?.approvals, homeModel(), projects.map(p => [p.path, p.name])]);
  if (box.controlsSig !== controlsSig) {
    box.controlsSig = controlsSig;
    const projBtn = h('button', { class: 'cbtn proj-pick' + (g ? '' : ' need'), type: 'button', title: g ? g.path : 'Choose a project folder', 'aria-haspopup': 'menu' }, icon('folder', 14), h('span', { class: 'ell' }, g ? g.name : 'Choose a folder'), icon('chevron-down', 12, 'cbtn-chev'));
    projBtn.addEventListener('click', () => {
      if (!projects.length) return H.openFolder();
      const items = projects.slice(0, 12).map((x) => ({ label: x.name, hint: x.path, on: x.path === draft.project, run: () => ((draft.project = x.path), redraw()) }));
      popMenu(projBtn, [...items, '-', { label: 'Open folder…', run: () => H.openFolder() }], { minWidth: 280 });
    });

    const m = homeModel();
    const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new conversation' }, brandMark(m?.provider, 14, 'pv-mark'), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default model'), icon('chevron-down', 12, 'cbtn-chev'));
    modelBtn.addEventListener('click', () => !engineReady() ? H.settings('engine') : modelPicker({
      load: () => loadHomeModels(draft.project),
      // Without an open session the list comes from a short-lived agent, which takes a moment to start.
      loading: models || [...S.tabs.values()].some((t) => !t.dead && t.ready) ? 'Loading models…' : 'Asking your providers for their models…',
      current: homeModel(),
      extra: 'Default: your saved default model, or the first one listed',
      onPick: (x) => {
        savePrefs({ homeModel: x ? { provider: x.provider, id: x.id, name: x.name || x.id } : null });
        redraw();
      },
    }));

    const unsaved = h('button', { class: 'cbtn on', type: 'button', title: 'This conversation will not be saved. Click to save it as usual.', hidden: !draft.ephemeral, onclick: () => ((draft.ephemeral = false), (unsaved.hidden = true)) }, h('span', null, 'Not saved'), icon('x', 12));

    // Plan first: the session starts in plan mode (reads and proposes, changes nothing), then gets the task.
    const modes = h('div', { class: 'task-modes', role: 'radiogroup', 'aria-label': 'Task mode' },
      ...[[false, 'Build', 'Build: it edits files and runs commands'], [true, 'Plan', 'Plan: it reads and proposes a plan, and changes nothing']].map(([plan, label, title]) => h('button', { class: 'task-mode', type: 'button', role: 'radio', title, 'aria-checked': String(!!draft.plan === plan), onclick: () => {
        draft.plan = plan;
        redraw();
      } }, label)));
    const apprBtn = permissionChip().el;
    const go = h('button', { class: 'send start', type: 'button' });
    box.go = go;
    updateStart(box);
    box.start = async () => {
      if (starting) return; // Enter twice, or Enter and a click: one session
      if (!draft.project) return H.openFolder();
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
        await api.post('/api/workspaces', { path: workspace }).then((r) => (S.workspaces = r.workspaces)).catch(() => {});
        const tab = await openTab({ workspace, model: mm ? `${mm.provider}/${mm.id}` : undefined, noSession: ephemeral || undefined, branch: !!branch });
        if (draft.project === workspace) draft.ephemeral = false;
        comp.reset(p?.raw);
        persistDraft();
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
    row.replaceChildren(addContext(comp), projBtn, modelBtn, branchBtn || '', unsaved, h('span', { class: 'grow' }), modes, apprBtn, go);
  }
  const rec = recipes(comp);
  if (rec.parentNode !== w.under) w.under.replaceChildren(rec);

  if (boardChanged(w, projects)) {
    const focused = w.boardSlot.querySelector('.session-library')?.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused?.matches('input') ? [focused.selectionStart,focused.selectionEnd] : null;
    const cl = checklist(H, projects);
    w.boardSlot.replaceChildren(cl || '', history || projects.length ? board(H, projects) : '');
    if(focused?.isConnected){focused.focus({preventScroll:true});if(selection)focused.setSelectionRange(...selection);}
  }
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
}

/**
 * The lists below the box are rebuilt only when what they show changed. Agents report status many times a minute;
 * rebuilding on each report restarted every animation and dropped the hover state under the pointer.
 */
function boardChanged(w, projects) {
  const sig = JSON.stringify([
    S.ui.pinned,
    draft.project,
    engineReady(),
    Math.floor(Date.now() / 60000), // relative times ("2m") stay current
    projects.map((g) => [g.path, g.sessions.length]),
    S.sessions.slice(0, 400).map((s) => [s.id, s.mtime, s.title]),
    [...S.tabs.values()].map((t) => [t.id, !!t.dead, !!t.streaming, t.dialogs.some(isApproval), t.workspace]),
  ]);
  if (w.boardSig === sig && w.boardSlot.isConnected) return false;
  w.boardSig = sig;
  return true;
}

/** One question for an open project; otherwise the next setup step. */
function drawHead(w, ready, project) {
  const text = project ? `What should we work on in ${project.name}?` : ready ? 'Open a project folder' : 'Connect a model';
  // The project's name carries the accent: it is the one word in the question that changes.
  if (w.title.textContent !== text) w.title.replaceChildren(...(project ? ['What should we work on in ', h('span', { class: 'home-title-p' }, project.name), '?'] : [text]));
  w.title.title = project ? project.path : '';
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
        details.textContent = git?.gitMissing ? 'Git isn’t available' : 'Not a Git repository';
      } else {
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

/** Recent conversations beside the projects and this week's activity. */
function board(H, projects) {
  return h('div', { class: 'home-board' }, sessionLibrary(H), projectsCard(H, projects));
}

/** What is still needed before the first task. Optional extras live in Settings, not here. */
function checklist(H, projects) {
  const steps = [
    { done: engineReady(), t: 'Connect a model', act: 'Connect', run: () => H.settings('engine') },
    { done: projects.length > 0, t: 'Open a project folder', act: 'Open folder', run: () => H.openFolder() },
    { done: S.sessions.length > 0, t: 'Run your first task' },
  ];
  const left = steps.filter((s) => !s.done).length;
  // With a model and a folder, the task box itself is the next step.
  if (steps[0].done && steps[1].done) return null;
  return h('ol', { class: 'home-steps', 'aria-label': `Setup: ${steps.length - left} of ${steps.length} done` }, steps.map((s, i) => h('li', { class: 'home-step' + (s.done ? ' done' : '') },
    h('span', { class: 'home-step-n', 'aria-hidden': 'true' }, s.done ? icon('check', 12) : String(i + 1)),
    h('span', { class: 'ell' }, s.t),
    !s.done && s.run ? h('button', { class: 'btn sm', type: 'button', onclick: s.run }, s.act) : null)));
}

const footKeys = () => h('div', { class: 'home-keys' }, [['Ctrl+K', 'search'], ['Ctrl+N', 'new conversation'], ['/', 'commands'], ['@', 'mention a file'], ['Ctrl+,', 'settings']].map(([k, l]) => h('span', null, kbd(k), ' ', l)));

// ================= first run =================

/** The providers on the first screen, one row each; a click opens Settings on that provider's form. */
// The first-run deck: one row per maker. OpenAI's row covers the ChatGPT plan and the API key, and opens on the plan sign-in.
const PV_SUB = { anthropic: 'Claude models', chatgpt: 'Your ChatGPT plan or an API key', google: 'Gemini models', xai: 'Grok models', openrouter: 'Hundreds of models, one account', ollama: 'Free models on this PC', lmstudio: 'Models from the LM Studio app' };
const PV_HOW = { anthropic: 'API key', chatgpt: 'Sign in', google: 'API key', xai: 'Sign in', openrouter: 'Sign in', ollama: 'No key', lmstudio: 'No key' };
const PV_NAME = { chatgpt: 'OpenAI' };
function focusProvider(H, id) {
  H.settings('engine');
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
    h('span', { class: 'cx-ic', 'aria-hidden': 'true' }, brandMark(p.id, 18)),
    h('span', { class: 'cx-n' }, PV_NAME[p.id] || p.name),
    h('span', { class: 'cx-s' }, PV_SUB[p.id]),
    h('span', { class: 'cx-how' }, on(p) ? 'Connected' : PV_HOW[p.id]))));
  return h('section', { class: 'home-connect', 'aria-label': 'Connect a model' },
    rows.length ? h('ul', { class: 'cx-list' }, ...rows) : h('p', { class: 'home-none' }, 'Choose a provider in Settings to connect your first model.'),
    h('div', { class: 'connect-foot' },
      h('span', { class: 'connect-acts' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => H.settings('engine') }, 'All providers'), h('button', { class: 'btn ghost sm', type: 'button', onclick: H.diagnostics }, 'Check my setup')),
      h('p', { class: 'setup-note' }, 'Keys are stored encrypted on this PC.')));
}

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}

/** Projects by last activity. A click aims the next session there. */
function projectsCard(H, projects) {
  const last = (g) => Math.max(0, ...g.sessions.map((s) => s.mtime || 0));
  const list = [...projects].sort((a, b) => last(b) - last(a)).slice(0, 5);
  const pick = (g) => {
    draft.project = g.path;
    const root = document.getElementById('welcome');
    drawHome(root, H);
    root.scrollTo({ top: 0, behavior: 'smooth' });
    C?.comp.focus({ preventScroll: true });
  };
  return h('section', { class: 'home-card', 'aria-label': 'Projects' },
    h('div', { class: 'home-card-h' }, h('h2', null, 'Projects'), h('button', { class: 'link', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 14), 'Open folder')),
    list.length ? h('div', { class: 'home-projs' }, ...list.map((g) => {
      const cur = g.path === draft.project;
      const n = g.sessions.length;
      const meta = `${n} conversation${n === 1 ? '' : 's'}${last(g) ? ` · ${timeAgo(last(g))}` : ''}`;
      return h('button', { class: 'home-proj' + (cur ? ' cur' : ''), type: 'button', title: `Start the next conversation in ${g.path}`, 'aria-pressed': String(cur), onclick: () => pick(g) },
        h('span', { class: 'home-proj-ic', 'aria-hidden': 'true' }, icon(cur ? 'folder-open' : 'folder', 16)),
        h('span', { class: 'home-proj-m' }, h('span', { class: 'home-proj-t ell' }, g.name), h('span', { class: 'home-proj-p ell' }, meta)),
        cur ? icon('check', 15, 'home-proj-cur') : null);
    })) : h('p', { class: 'home-none' }, 'The agent only works inside folders you open.'));
}
