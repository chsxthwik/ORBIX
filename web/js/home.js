// Home: start the next task, or get back to one. One message box, then what needs you, recent conversations and projects.
// Before a model is connected the same place offers the providers, with a self-playing session below.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, engineReady, savePrefs, groupSessions, on, setActive } from './store.js';
import { popMenu, modelPicker, isApproval } from './dialogs.js';
import { brandMark } from './brands.js';
import { asciiOrbit } from './ascii.js';
import { recipes } from './workspace.js';
import { sessionLibrary } from './session-library.js';

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

/** Choose the project the next session starts in (used by "New session in this project"). */
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
  const orbit = asciiOrbit({ cols: 64, rows: 15 });
  const where = h('p', { class: 'home-where' });
  const hero = h('section', { class: 'home-hero', 'aria-label': 'New task' }, h('div', { class: 'home-art', 'aria-hidden': 'true' }, orbit.el), h('header', { class: 'home-head' }, title, sub), alertSlot, deckSlot, where, under);
  const boardSlot = h('div', { class: 'home-board-slot' });
  const firstSlot = h('div', { class: 'home-first-slot' });
  const keysSlot = h('div', { class: 'home-keys-slot' });
  const wrap = h('div', { class: 'home workspace-home' }, hero, boardSlot, firstSlot, keysSlot);
  W = { wrap, orbit, where, title, sub, alertSlot, deckSlot, under, boardSlot, firstSlot, keysSlot };
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
    placeholder: 'Describe a task. Type @ to mention a file, / for commands.',
    label: 'Task for the new session',
    cls: 'home-composer',
    state: draft,
    workspace: () => draft.project,
    onSubmit: () => C?.start(),
    onChange: () => {
      if (C?.go) C.go.disabled = starting;
      clearTimeout(saveDraftTimer); saveDraftTimer = setTimeout(persistDraft, 250);
    },
  });
  const row = h('div', { class: 'c-row' });
  comp.el.append(row);
  C = { comp, row, el: comp.el };
  return C;
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
    if (boardChanged(w, 'first', projects)) {
      w.boardSlot.replaceChildren(history ? board(H, projects, false) : '');
    }
    w.firstSlot.replaceChildren();
    return;
  }
  w.firstSlot.replaceChildren();
  w.deckSig = null;

  const box = deck();
  const { comp, row } = box;
  if (box.el.parentNode !== w.deckSlot) w.deckSlot.replaceChildren(box.el);

  const controlsSig = JSON.stringify([draft.project, !!draft.plan, !!draft.ephemeral, agentOk, S.engine?.approvals, homeModel(), projects.map(p => [p.path, p.name])]);
  if (box.controlsSig !== controlsSig) {
    box.controlsSig = controlsSig;
    const projBtn = h('button', { class: 'cbtn proj-pick' + (g ? '' : ' need'), type: 'button', title: g ? g.path : 'Choose a project folder', 'aria-haspopup': 'menu' }, icon('folder', 14), h('span', { class: 'ell' }, g ? g.name : 'Choose a folder'), icon('chevron-down', 12, 'cbtn-chev'));
    projBtn.addEventListener('click', () => {
      if (!projects.length) return H.openFolder();
      const items = projects.slice(0, 12).map((x) => ({ label: x.name, hint: x.path, on: x.path === draft.project, run: () => ((draft.project = x.path), redraw()) }));
      popMenu(projBtn, [...items, '-', { label: 'Open folder…', run: () => H.openFolder() }], { minWidth: 280 });
    });

    const m = homeModel();
    const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new session' }, brandMark(m?.provider, 14, 'pv-mark'), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default model'), icon('chevron-down', 12, 'cbtn-chev'));
    modelBtn.addEventListener('click', () => !engineReady() ? H.settings('engine') : modelPicker({
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
    const modes = h('div', { class: 'task-modes', role: 'radiogroup', 'aria-label': 'Task mode' },
      ...[[false, 'Build', 'Build: it edits files and runs commands'], [true, 'Plan', 'Plan: it reads and proposes a plan, and changes nothing']].map(([plan, label, title]) => h('button', { class: 'task-mode', type: 'button', role: 'radio', title, 'aria-checked': String(!!draft.plan === plan), onclick: () => {
        draft.plan = plan;
        redraw();
      } }, label)));
    const auto = S.engine?.approvals === 'auto', editsOnly = S.engine?.approvals === 'edits';
    const apprBtn = h('button', { class: 'cbtn appr' + (auto ? ' risky' : ''), type: 'button', title: auto ? 'Approvals are off: it edits and runs commands without asking. Click to change.' : editsOnly ? 'File edits run without asking; commands wait for your OK. Click to change.' : 'Edits and commands wait for your OK. Click to change.', onclick: () => H.settings('behavior') }, icon('shield', 14), auto ? 'Approvals off' : editsOnly ? 'Edits allowed' : 'Asks first');
    const go = h('button', { class: 'send start', type: 'button', title: agentOk ? 'Start (Enter)' : 'Connect a model to run this task', 'aria-label': agentOk ? 'Start session' : 'Connect a model to start this task', disabled: starting }, agentOk ? 'Start' : 'Connect a model');
    box.go = go;
    box.start = async () => {
      if (starting) return; // Enter twice, or Enter and a click: one session
      if (!draft.project) return H.openFolder();
      if (!engineReady()) {
        toast('Connect a model first.', 'error', 4000);
        return H.settings('engine');
      }
      const p = comp.payload();
      starting = true;
      go.disabled = true;
      comp.el.classList.add('busy');
      try {
        const mm = homeModel();
        await api.post('/api/workspaces', { path: draft.project }).then((r) => (S.workspaces = r.workspaces)).catch(() => {});
        const tab = await openTab({ workspace: draft.project, model: mm ? `${mm.provider}/${mm.id}` : undefined, noSession: draft.ephemeral || undefined });
        draft.ephemeral = false;
        comp.reset(p?.raw);
        persistDraft();
        if (draft.plan) await sendPrompt(tab, '/plan');
        if (p) await sendPrompt(tab, p.text || '(see the attached image)', { images: p.images });
      } catch (e) {
        if (p && !comp.hasContent()) { comp.restore(p); persistDraft(); }
        toast(e.message, 'error', 8000);
      } finally {
        starting = false;
        if (C) {
          C.go.disabled = false;
          C.comp.el.classList.remove('busy');
        }
      }
    };
    go.addEventListener('click', () => box.start());

    row.replaceChildren(iconBtn('paperclip', 'Attach images or text files', () => comp.openFilePicker()), projBtn, modelBtn, apprBtn, unsaved, h('span', { class: 'grow' }), modes, go);
  }
  const rec = recipes(comp);
  if (rec.parentNode !== w.under) w.under.replaceChildren(rec);

  if (boardChanged(w, 'ready', projects)) {
    const focused = w.boardSlot.querySelector('.session-library')?.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused?.matches('input') ? [focused.selectionStart,focused.selectionEnd] : null;
    const cl = checklist(H, projects);
    w.boardSlot.replaceChildren(cl || '', history || projects.length ? board(H, projects, true) : '');
    if(focused?.isConnected){focused.focus({preventScroll:true});if(selection)focused.setSelectionRange(...selection);}
  }
  const live = liveTabs();
  w.wrap.classList.toggle('is-busy', live.working.length > 0);
  w.wrap.classList.toggle('is-wait', live.waiting.length > 0);

  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
}

/**
 * The lists below the box are rebuilt only when what they show changed. Agents report status many times a minute;
 * rebuilding on each report restarted every animation and dropped the hover state under the pointer.
 */
function boardChanged(w, mode, projects) {
  const sig = JSON.stringify([
    mode,
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

/** With a project: the planet, the task box and where it will run. Without one: what to do first. */
function drawHead(w, ready, project) {
  const live = liveTabs();
  w.orbit.setMode(live.waiting.length ? 'wait' : live.working.length ? 'busy' : 'idle');
  w.wrap.classList.toggle('has-project', !!project);
  const text = project ? '' : ready ? 'Open a project folder' : 'Connect a model';
  if (w.title.textContent !== text) w.title.textContent = text;
  const sub = project ? '' : ready ? 'The agent works only inside a folder you choose.' : 'Add an API key, sign in, or use a model that runs on this PC. You can change it at any time.';
  if (w.sub.textContent !== sub) w.sub.textContent = sub;
  w.title.parentNode.hidden = !!project;
  const where = project ? project.path : '';
  if (w.where.textContent !== where) w.where.textContent = where;
  w.where.hidden = !project;
  w.where.title = where;
}

/** Sessions working or waiting on you, above everything else: this is what you came back for. */
function attention(H) {
  const { waiting, working } = liveTabs();
  return [...waiting, ...working.filter((t) => !waiting.includes(t))].slice(0, 3).map((t) => {
    const wait = waiting.includes(t);
    const s = S.sessions.find((x) => tabForSession(x) === t);
    return h('button', { class: `home-alert ${wait ? 'wait' : 'run'}`, type: 'button', onclick: () => (s ? H.openSession(s) : setActive(t.id)) },
      h('span', { class: 'dot ' + (wait ? 'warn' : 'run') }),
      h('span', { class: 'home-alert-t ell' }, s?.title || t.name || 'Session'),
      h('span', { class: 'home-alert-p ell' }, baseName(t.workspace || '')),
      h('span', { class: 'home-alert-s' }, wait ? 'Needs your OK' : 'Working'),
      icon('chevron-right', 14));
  });
}

/** Recent conversations beside the projects and this week's activity. */
function board(H, projects, canPick) {
  return h('div', { class: 'home-board' }, sessionLibrary(H), h('div', {class:'home-side'},projectsCard(H, projects, canPick)));
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

const footKeys = () => h('div', { class: 'home-keys' }, [['Ctrl+K', 'search'], ['Ctrl+N', 'new session'], ['/', 'commands'], ['@', 'mention a file'], ['Ctrl+,', 'settings']].map(([k, l]) => h('span', null, kbd(k), ' ', l)));

// ================= first run =================

/** The providers on the first screen, one row each; a click opens Settings on that provider's form. */
const PV_SUB = { anthropic: 'Claude models', openai: 'GPT and o-series', google: 'Gemini models', xai: 'Grok models', openrouter: 'Hundreds of models, one account', ollama: 'Models on this PC', lmstudio: 'Models on this PC' };
const PV_HOW = { anthropic: 'API key', openai: 'Sign in', google: 'API key', xai: 'Sign in', openrouter: 'Sign in', ollama: 'No key', lmstudio: 'No key' };
function focusProvider(H, id) {
  H.settings('engine');
  const t0 = Date.now();
  const tick = () => {
    const card = document.querySelector(`.pv-card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      if (!card.classList.contains('open')) card.querySelector('.pv-head')?.click();
      const open = document.querySelector(`.pv-card[data-id="${CSS.escape(id)}"]`);
      open.scrollIntoView({ block: 'center' });
      open.classList.add('flash');
      open.querySelector('.pv-oauth .btn, .pv-key, .pv-url, .pv-form .btn')?.focus({ preventScroll: true });
    } else if (Date.now() - t0 < 3000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function connectDeck(H) {
  const all = S.engine?.providers || [];
  const rows = all.filter((p) => p.id in PV_SUB).map((p) => h('li', null, h('button', { class: 'cx-row' + (p.configured ? ' on' : ''), type: 'button', title: `Connect ${p.name}`, onclick: () => focusProvider(H, p.id) },
    h('span', { class: 'cx-ic', 'aria-hidden': 'true' }, brandMark(p.id, 18)),
    h('span', { class: 'cx-n' }, p.name),
    h('span', { class: 'cx-s' }, PV_SUB[p.id]),
    h('span', { class: 'cx-how' }, p.configured ? 'Connected' : PV_HOW[p.id]))));
  return h('section', { class: 'home-connect', 'aria-label': 'Connect a model' },
    rows.length ? h('ul', { class: 'cx-list' }, ...rows) : h('p', { class: 'home-none' }, 'Choose a provider in Settings to connect your first model.'),
    h('div', { class: 'connect-foot' },
      h('span', { class: 'connect-acts' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => H.settings('engine') }, all.length ? `All ${all.length} providers` : 'All providers'), h('button', { class: 'btn ghost sm', type: 'button', onclick: H.diagnostics }, 'Check my setup')),
      h('p', { class: 'setup-note' }, 'Keys are stored encrypted on this PC.')));
}

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}

/** Projects by last activity. A click aims the next session there. */
function projectsCard(H, projects, canPick) {
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
    h('div', { class: 'home-card-h' }, h('h2', null, 'Projects'), h('button', { class: 'link', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 13), 'Open folder')),
    list.length ? h('div', { class: 'home-rows' }, ...list.map((g) => {
      const cur = canPick && g.path === draft.project;
      const n = g.sessions.length;
      const meta = `${n} conversation${n === 1 ? '' : 's'}${last(g) ? ` · ${timeAgo(last(g))}` : ''}`;
      // Before a model is connected there is no task box to aim, so the row is a plain readout rather than a dead button.
      const start = canPick ? { type: 'button', title: `Start the next session in ${g.path}`, 'aria-pressed': String(cur), onclick: () => pick(g) } : { title: g.path };
      return h(canPick ? 'button' : 'div', { class: 'home-row proj' + (cur ? ' cur' : '') + (canPick ? '' : ' static'), ...start },
        icon(cur ? 'folder-open' : 'folder', 15),
        h('span', { class: 'home-row-m' }, h('span', { class: 'home-row-t ell' }, g.name), h('span', { class: 'home-row-p ell' }, meta)),
        cur ? icon('check', 14, 'home-row-cur') : null);
    })) : h('p', { class: 'home-none' }, 'The agent only works inside folders you open.'));
}
