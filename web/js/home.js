// Home: start the next task, or get back to one. One message box, then what needs you, recent conversations and projects.
// Before a model is connected the same place offers the providers, with a self-playing session below.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd, logo } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, engineReady, savePrefs, groupSessions, on, setActive } from './store.js';
import { popMenu, modelPicker, isApproval } from './dialogs.js';
import { brandMark } from './brands.js';
import { asciiOrbit, decodeText, typePlaceholder } from './ascii.js';
import { resumeCard, heatmapCard, recipes } from './workspace.js';

// The home screen is redrawn when sessions or providers change. The message box stays mounted (so typing, IME
// composition and the caret are never interrupted); only the parts around it are redrawn.
const draft = { draft: '', attach: [], project: '', ephemeral: false };
let models = null; // models of the configured providers, fetched once per provider change
let W = null; // the mounted page: its persistent slots
let C = null; // the mounted task box: { comp, el, row, go, start }
let starting = false;
on('engine', () => (models = null));

/** Choose the project the next session starts in (used by "New session in this project"). */
export function setHomeProject(path, { ephemeral } = {}) {
  if (path) draft.project = path;
  if (ephemeral != null) draft.ephemeral = ephemeral;
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
  const orbit = asciiOrbit();
  const hi = h('p', { class: 'home-hi' });
  const hero = h('section', { class: 'home-hero', 'aria-label': 'New task' }, h('span', { class: 'home-mark', 'aria-hidden': 'true' }, orbit.el, logo(36, { alive: true })), hi, title, sub, alertSlot, deckSlot, under);
  const boardSlot = h('div', { class: 'home-board-slot' });
  const firstSlot = h('div');
  const keysSlot = h('div');
  const wrap = h('div', { class: 'home' }, hero, boardSlot, firstSlot, keysSlot);
  W = { wrap, orbit, hi, title, sub, alertSlot, deckSlot, under, boardSlot, firstSlot, keysSlot };
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
    placeholder: 'Describe a task, and ORBIX gets to work.',
    label: 'Task for the new session',
    cls: 'home-composer',
    state: draft,
    workspace: () => draft.project,
    onSubmit: () => C?.start(),
    onChange: () => C?.go && (C.go.disabled = starting),
  });
  const row = h('div', { class: 'c-row' });
  comp.el.append(row);
  typePlaceholder(comp.ta, ['find why the login test fails and fix it', 'explain how this project is put together', 'review my uncommitted changes for bugs', 'add a dark mode switch to the settings page'], 'Try: ');
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

  drawHead(w, agentOk, projects.length > 0);
  w.keysSlot.replaceChildren(footKeys());
  w.alertSlot.replaceChildren(...attention(H));

  if (!agentOk) {
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
      w.boardSlot.replaceChildren((history && resumeCard(H)) || '', history ? board(H, projects, false) : '', history ? heatmapCard(projects) : '');
    }
    if (!w.firstSlot.firstChild) {
      const fr = firstRun();
      w.firstSlot.replaceChildren(fr);
    }
    // The preview stops on its own when Home is not on screen.
    queueMicrotask(() => DEMO?.play());
    return;
  }
  if (DEMO?.el.isConnected) DEMO.stop();
  w.firstSlot.replaceChildren();
  w.deckSig = null;

  const box = deck();
  const { comp, row } = box;
  if (box.el.parentNode !== w.deckSlot) w.deckSlot.replaceChildren(box.el);

  const projBtn = h('button', { class: 'cbtn proj-pick' + (g ? '' : ' need'), type: 'button', title: g ? g.path : 'Choose a project folder', 'aria-haspopup': 'menu' }, icon('folder', 14), h('span', { class: 'ell' }, g ? g.name : 'Choose a folder'), icon('chevron-down', 12, 'cbtn-chev'));
  projBtn.addEventListener('click', () => {
    if (!projects.length) return H.openFolder();
    const items = projects.slice(0, 12).map((x) => ({ label: x.name, hint: x.path, on: x.path === draft.project, run: () => ((draft.project = x.path), redraw()) }));
    popMenu(projBtn, [...items, '-', { label: 'Open folder…', run: () => H.openFolder() }], { minWidth: 280 });
  });

  const m = homeModel();
  const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new session' }, brandMark(m?.provider, 14, 'pv-mark'), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default model'), icon('chevron-down', 12, 'cbtn-chev'));
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
  const planBtn = h('button', { class: 'cbtn' + (draft.plan ? ' on' : ''), type: 'button', 'aria-pressed': String(!!draft.plan), title: 'Start in plan mode: it reads and proposes a plan, and changes nothing until you turn plan mode off', onclick: () => ((draft.plan = !draft.plan), redraw()) }, icon('map', 14), 'Plan first');
  const auto = S.engine?.approvals === 'auto';
  const apprBtn = h('button', { class: 'cbtn appr' + (auto ? ' risky' : ''), type: 'button', title: auto ? 'Approvals are off: it edits and runs commands without asking. Click to change.' : 'Edits and commands wait for your OK. Click to change.', onclick: () => H.settings('behavior') }, icon('shield', 14), auto ? 'Approvals off' : 'Asks first');
  const go = h('button', { class: 'send start', type: 'button', title: 'Start (Enter)', 'aria-label': 'Start session', disabled: starting }, h('span', null, 'Start'));
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
      if (draft.plan) await sendPrompt(tab, '/plan');
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
  go.addEventListener('click', () => box.start());

  row.replaceChildren(iconBtn('paperclip', 'Attach images or text files', () => comp.openFilePicker()), projBtn, modelBtn, planBtn, apprBtn, unsaved, h('span', { class: 'grow' }), go);
  const rec = recipes(comp);
  if (rec.parentNode !== w.under) w.under.replaceChildren(rec);

  if (boardChanged(w, 'ready', projects)) {
    const cl = checklist(H, projects);
    w.boardSlot.replaceChildren(cl || '', (history && resumeCard(H)) || '', history || projects.length ? board(H, projects, true) : '', history ? heatmapCard(projects) : '');
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

const hello = () => {
  const n = new Date().getHours();
  return n < 5 ? 'Up late?' : n < 12 ? 'Good morning' : n < 17 ? 'Good afternoon' : 'Good evening';
};

/** The one question on the screen. It decodes into place when it changes, not on every redraw. */
function drawHead(w, ready, hasProject) {
  const live = liveTabs();
  w.orbit.setMode(live.waiting.length ? 'wait' : live.working.length ? 'busy' : 'idle');
  w.hi.replaceChildren(hello(), h('span', { class: 'home-date' }, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })));
  const text = !ready ? 'Connect a model to get started' : hasProject ? 'What should we work on?' : 'Pick a project to start';
  if (w.titleText !== text) {
    w.titleText = text;
    w.title.textContent = text;
    // After layout, so the letters can be measured.
    requestAnimationFrame(() => w.titleText === text && decodeText(w.title, text));
  }
  w.sub.textContent = !ready ? 'ORBIX reads your code first, asks before edits or commands, and keeps every change undoable.' : hasProject ? '' : 'The agent only ever works inside a folder you choose.';
  w.sub.hidden = !w.sub.textContent;
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
  return h('div', { class: 'home-board' }, h('div', { class: 'home-side' }, recentCard(H), S.sessions.length ? weekCard(projects) : null), projectsCard(H, projects, canPick));
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

/** The providers on the first screen, one tile each; a click opens Settings on that provider's form. */
const PV_SUB = { anthropic: 'Claude models', openai: 'GPT and o-series', google: 'Gemini, free tier', openrouter: 'Sign in, hundreds of models', ollama: 'Runs on this PC, no key', lmstudio: 'Runs on this PC, no key' };
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
  const list = (S.engine?.providers || []).filter((p) => p.id in PV_SUB);
  const tiles = list.map((p) => h('button', { class: 'pv-q' + (p.local ? ' local' : '') + (p.configured ? ' on' : ''), type: 'button', title: `Connect ${p.name}`, onclick: () => focusProvider(H, p.id) },
    h('span', { class: 'pv-q-ic', 'aria-hidden': 'true' }, brandMark(p.id, 20)),
    h('span', { class: 'pv-q-main' }, h('span', { class: 'pv-q-n' }, p.name), h('span', { class: 'pv-q-s' }, PV_SUB[p.id])),
    p.configured ? h('span', { class: 'dot ok' }) : icon('chevron-right', 14)));
  return h('section', { class: 'home-connect', 'aria-label': 'Connect a model' },
    h('div', { class: 'pv-quick' }, ...tiles),
    h('div', { class: 'connect-foot' }, h('p', { class: 'setup-note' }, icon('shield', 13), 'Keys are stored encrypted on this PC.'),
      h('span', { class: 'connect-acts' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => H.settings('engine') }, 'All providers'), h('button', { class: 'btn ghost sm', type: 'button', onclick: H.diagnostics }, 'Check my setup'))));
}

/** What the agent does, in six lines. The accent marks the places you decide. */
const FEATURES = [
  ['eye', '', 'Reads your code', 'Files, search and git history, before it changes anything.'],
  ['pencil', 'you', 'Edits with your OK', 'Each change is shown as a diff first. You approve or deny.'],
  ['terminal', '', 'Runs commands', 'Tests, builds and scripts, in WSL or on Windows.'],
  ['undo', 'you', 'Undo any edit', 'The previous version of every file is kept. One click restores it.'],
  ['globe', '', 'Searches the web', 'Reads documentation and looks up facts, when you allow it.'],
  ['plug', '', 'Adds MCP tools', 'Tools from any MCP server. A project’s servers start only after you say so.'],
];

/** Below the stage on the first screen: a session that plays itself beside what the agent can do. */
function firstRun() {
  return h('section', { class: 'ws-first', 'aria-label': 'What a session looks like' },
    h('div', { class: 'ws-first-demo' }, h('div', { class: 'ws-panel-h' }, h('h2', null, 'A session, start to finish')), demo()),
    h('div', { class: 'ws-first-feat' }, h('div', { class: 'ws-panel-h' }, h('h2', null, 'Capabilities'), h('span', { class: 'ws-panel-note' }, 'Edits and commands wait for your OK')),
      h('ul', { class: 'ws-feat' }, ...FEATURES.map(([ic, tone, t, d]) => h('li', { class: 'feat' + (tone ? ' ' + tone : '') }, h('span', { class: 'feat-ic' }, icon(ic, 15)), h('span', { class: 'feat-m' }, h('span', { class: 'feat-t' }, t), h('span', { class: 'feat-d' }, d)))))));
}

/**
 * The preview in the first screen's header: a short session that plays itself (a task typed in, the agent's steps,
 * the result), so the first thing you see is what a session looks like. Built once. It loops while it is on screen,
 * pauses while Home is hidden, and under prefers-reduced-motion shows the finished state instead.
 */
let DEMO = null;
const DEMO_TASK = 'The login test fails about one run in five. Find out why and fix it.';
const DEMO_STEPS = [
  ['read', 'eye', 'read', 'test/login.test.js', '', ''],
  ['read', 'eye', 'read', 'src/auth/token.js', '', ''],
  ['cmd', 'terminal', 'bash', 'npm test -- login', 'FAIL · 401', 'err'],
  ['edit', 'pencil', 'edit', 'src/auth/token.js', '+1 −1', ''],
  ['cmd', 'terminal', 'bash', 'npm test -- login', 'PASS ×6', 'ok'],
];
const DEMO_DONE = 'The token expired before the second request on slow machines. Expiry is now 500 ms, and a new test covers the slow path.';
function demo() {
  if (DEMO) return DEMO.el;
  const txt = h('span', { class: 'demo-txt' });
  const you = h('div', { class: 'demo-you' }, txt, h('i', { class: 'demo-caret' }));
  const steps = h('div', { class: 'demo-steps' });
  const done = h('div', { class: 'demo-done', hidden: true }, logo(16), h('span', null, DEMO_DONE), h('span', { class: 'demo-undo' }, icon('undo', 11), 'Undo'));
  const st = h('span', { class: 'demo-st' });
  const el = h('div', { class: 'demo', 'aria-hidden': 'true' },
    h('div', { class: 'demo-bar' }, h('span', { class: 'dot' }), h('span', null, 'Example session'), st),
    h('div', { class: 'demo-body' }, you, steps, done));
  const row = ([k, ic, name, arg, out, tone]) => h('div', { class: `demo-row ${k}` }, icon(ic, 13), h('span', { class: 'demo-name' }, name), h('span', { class: 'demo-arg' }, arg), out ? h('span', { class: 'demo-out ' + tone }, out) : null);
  const show = (state, label) => {
    el.className = 'demo ' + state;
    st.textContent = label;
  };
  let timer = 0;
  const later = (fn, ms) => {
    timer = setTimeout(() => {
      timer = 0;
      if (!el.isConnected) return void (DEMO.playing = false);
      if (!el.checkVisibility()) return later(fn, 1000);
      fn();
    }, ms);
  };
  const finish = () => {
    steps.replaceChildren(...DEMO_STEPS.map(row));
    txt.textContent = DEMO_TASK;
    done.hidden = false;
    show('typed done', 'done · 1 file changed');
  };
  const play = () => {
    if (DEMO.playing || !el.isConnected) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
    DEMO.playing = true;
    txt.textContent = '';
    steps.replaceChildren();
    done.hidden = true;
    show('', '');
    let i = 0;
    let s = 0;
    const step = () => {
      if (s < DEMO_STEPS.length) {
        const spec = DEMO_STEPS[s++];
        const r = row(spec);
        const out = r.querySelector('.demo-out');
        if (out) {
          out.textContent = '…';
          out.className = 'demo-out live';
        }
        steps.append(r);
        return later(() => {
          if (out) {
            out.textContent = spec[4];
            out.className = 'demo-out ' + spec[5];
          }
          later(step, 450);
        }, out ? 900 : 350);
      }
      done.hidden = false;
      show('typed done', 'done · 1 file changed');
      later(() => {
        DEMO.playing = false;
        play();
      }, 7000);
    };
    const type = () => {
      if (i < DEMO_TASK.length) {
        txt.textContent = DEMO_TASK.slice(0, ++i);
        return later(type, i === 1 ? 600 : 18 + Math.random() * 28);
      }
      show('typed run', 'working');
      later(step, 700);
    };
    type();
  };
  DEMO = { el, play, playing: false, stop: () => {
    clearTimeout(timer);
    timer = 0;
    DEMO.playing = false;
  } };
  return el;
}

// ================= lists =================
// Everything here is read from real state: the saved conversations and the open tabs. Nothing is invented.

const DAY = 864e5;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}

/** Recent conversations, one click from where they stopped. */
function recentCard(H, n = 7) {
  const rows = S.sessions.slice(0, n).map((s) => {
    const open = tabForSession(s);
    const waiting = open && open.dialogs.some(isApproval);
    const state = waiting ? 'wait' : open?.streaming ? 'run' : open ? 'open' : '';
    return h('button', { class: 'home-row', type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
      h('span', { class: 'home-row-m' }, h('span', { class: 'home-row-t ell' }, s.title), h('span', { class: 'home-row-p ell' }, baseName(s.cwdDisplay || s.cwd))),
      state ? h('span', { class: `home-tag ${state}` }, state === 'wait' ? 'Needs you' : state === 'run' ? 'Working' : 'Open') : h('span', { class: 'home-row-w num' }, timeAgo(s.mtime)),
      icon('chevron-right', 14, 'home-row-go'));
  });
  return h('section', { class: 'home-card', 'aria-label': 'Recent conversations' },
    h('div', { class: 'home-card-h' }, h('h2', null, 'Recent'), rows.length ? h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage') : null),
    rows.length ? h('div', { class: 'home-rows' }, ...rows) : h('p', { class: 'home-none' }, 'Conversations appear here. Each one is saved and can be resumed.'));
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

/** Conversations last active on each of the past seven days. */
function weekCard(projects) {
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
  const counts = days.map((d) => S.sessions.filter((s) => startOfDay(s.mtime) === d).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  return h('section', { class: 'home-card home-week', 'aria-label': 'This week' },
    h('div', { class: 'home-card-h' }, h('h2', null, 'This week')),
    h('div', { class: 'home-week-b' },
      h('div', { class: 'home-week-n' }, h('b', { class: 'num' }, String(total)), h('span', null, `conversation${total === 1 ? '' : 's'} in ${projects.length} project${projects.length === 1 ? '' : 's'}`)),
      h('span', { class: 'home-bars', role: 'img', 'aria-label': `Conversations per day, oldest first: ${counts.join(', ')}` }, ...days.map((d, i) => h('span', { class: 'home-bar' + (i === 6 ? ' today' : ''), title: `${new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${counts[i]}` }, h('i', { style: { height: `${Math.max(counts[i] ? 18 : 6, (counts[i] / max) * 100)}%` } }), h('small', null, new Date(d).toLocaleDateString(undefined, { weekday: 'narrow' })))))));
}
