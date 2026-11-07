// Home: the dashboard. A composer to start a session (project, model, plan first), what is running now, the numbers,
// activity, projects and recent conversations. With no AI provider set up, the setup card takes the composer's place.
import { h, icon, iconBtn, replace, baseName, timeAgo, toast, kbd, logo } from './dom.js';
import { Composer, dropZone } from './composer.js';
import { api, rpc } from './api.js';
import { S, openTab, sendPrompt, tabForSession, engineReady, savePrefs, groupSessions, on, setActive } from './store.js';
import { popMenu, modelPicker, isApproval } from './dialogs.js';
import { refreshGlyphs } from './glyphs.js';

// The home screen is redrawn when sessions or providers change. The message box itself stays mounted (so typing,
// IME composition and the caret are never interrupted); only the parts around it are redrawn.
const draft = { draft: '', attach: [], project: '', ephemeral: false };
let models = null; // models of the configured providers, fetched once per provider change
let C = null; // the mounted home view: { wrap, comp, row, heroSlot, tabsSlot, lowerSlot, keysSlot, nowSlot, kpiSlot }
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

export function drawHome(root, H) {
  const agentOk = engineReady();
  const redraw = () => {
    drawHome(root, H);
    C?.comp.focus();
  };
  if (!agentOk) {
    // First run: one welcome and one next step. Numbers and charts wait until there is something to count.
    C = null;
    const has = S.sessions.length > 0;
    // The wrapper and its header persist; only what follows the header is rebuilt (keeps the logo's orbit running).
    const hd = dashHead(H);
    if (!FIRST || !root.contains(FIRST) || hd.parentNode !== FIRST) {
      FIRST = h('div', { class: 'home dash first' }, hd);
      replace(root, FIRST);
    }
    while (hd.nextSibling) hd.nextSibling.remove();
    // The preview plays in the header's art area; it stops on its own when Home is not on screen.
    const art = hd.querySelector('.d-art');
    if (art && !art.contains(demo())) art.replaceChildren(demo());
    FIRST.append(connectCard(H), featuresStrip(), ...(has ? [h('div', { class: 'd-grid two' }, recentCard(H), projectsCard(H, groupSessions().filter((g) => g.path)))] : []), footKeys());
    refreshGlyphs();
    queueMicrotask(() => DEMO?.play());
    return;
  }
  if (DEMO?.el.isConnected) {
    DEMO.stop();
    DEMO.el.remove();
  }

  const projects = groupSessions().filter((g) => g.path);
  if (!projects.some((g) => g.path === draft.project)) draft.project = projects[0]?.path || '';

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
    // Layout: header, then the launch card (project tabs, the task box) beside Now, the numbers, then the lower grid.
    const heroSlot = h('div');
    const tabsSlot = h('div', { class: 'launch-tabs' });
    const launch = h('div', { class: 'launch' }, tabsSlot, comp.el);
    const lowerSlot = h('div', { class: 'd-grid' });
    const keysSlot = h('div');
    const nowSlot = h('div', { class: 'd-now-slot' });
    const kpiSlot = h('div');
    const qpSlot = h('div');
    const launchCard = h('section', { class: 'd-card d-launch', 'aria-label': 'New session' }, h('div', { class: 'd-card-h' }, h('h2', null, 'New session'), h('span', { class: 'd-card-note' }, 'Describe what you want. The agent asks before it changes anything.')), launch, qpSlot);
    const wrap = h('div', { class: 'home dash' }, heroSlot, h('div', { class: 'd-top' }, launchCard, nowSlot), kpiSlot, lowerSlot, keysSlot);
    C = { wrap, comp, row, heroSlot, tabsSlot, lowerSlot, keysSlot, nowSlot, kpiSlot, qpSlot };
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

  const m = homeModel();
  const modelBtn = h('button', { class: 'cbtn', type: 'button', title: 'Model for the new session' }, h('span', { class: 'cbtn-k' }, 'Model'), h('span', { class: 'ell' }, m ? m.name || m.id : 'Default'), icon('chevron-down', 12, 'cbtn-chev'));
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
  const apprBtn = h('button', { class: 'cbtn appr' + (auto ? ' off' : ''), type: 'button', title: auto ? 'Approvals are off: it edits and runs commands without asking. Click to change.' : 'Edits and commands wait for your OK. Click to change.', onclick: () => H.settings('behavior') }, h('span', { class: 'appr-sq', 'aria-hidden': 'true' }), auto ? 'Approvals off' : 'Asks before changes');
  const go = h('button', { class: 'send', type: 'button', title: 'Start (Enter)', 'aria-label': 'Start session', disabled: starting }, icon('send', 16));
  C.go = go;
  C.start = async () => {
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
  go.addEventListener('click', () => C.start());

  row.replaceChildren(iconBtn('paperclip', 'Attach images or text files', () => comp.openFilePicker()), projects.length ? '' : projBtn, modelBtn, planBtn, apprBtn, unsaved, h('span', { class: 'grow' }), h('span', { class: 'c-hint' }, kbd('Enter'), ' to start'), go);
  const hd = dashHead(H, g);
  if (hd.parentNode !== C.heroSlot) C.heroSlot.replaceChildren(hd);
  // Show only what means something now: Now while a session is open, the numbers and charts once there is history.
  const anyLive = liveTabs().live.length > 0;
  const history = S.sessions.length > 0;
  C.nowSlot.replaceChildren(anyLive ? nowCard(H) : '');
  C.nowSlot.hidden = !anyLive;
  C.wrap.querySelector('.d-top')?.classList.toggle('solo', !anyLive);
  C.kpiSlot.replaceChildren(history ? kpis(projects) : '');
  C.kpiSlot.hidden = !history;
  C.tabsSlot.replaceChildren(...projectTabs(H, projects, () => redraw()));
  C.tabsSlot.hidden = !projects.length;
  // Example tasks until there is a history of real ones.
  C.qpSlot.replaceChildren(history ? '' : quickPrompts(comp));
  C.qpSlot.hidden = history;
  const cl = checklist(H, projects);
  C.lowerSlot.replaceChildren(...(history ? [activityCard(), projectsCard(H, projects), recentCard(H)] : []), cl || '');
  C.lowerSlot.hidden = !history && !cl;
  C.keysSlot.replaceChildren(footKeys());
  refreshGlyphs();
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) queueMicrotask(() => {
    if (!root.hidden && !document.querySelector('.scrim')) comp.focus();
  });
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

const greeting = () => new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/**
 * Getting set up: a short checklist read from the real state, each open step with the one action that does it.
 * It disappears once everything is done.
 */
function checklist(H, projects) {
  const steps = [
    { done: engineReady(), t: 'Connect a model', d: 'An API key or a local model, stored encrypted on this PC.', act: 'Connect', run: () => H.settings('engine') },
    { done: projects.length > 0, t: 'Pick a project folder', d: 'The agent only ever works inside the folder you choose.', act: 'Open folder', run: () => H.openFolder() },
    { done: S.sessions.length > 0, t: 'Run your first task', d: 'Type it above and press Enter. Every edit can be undone.' },
    { done: !!S.engine?.search?.configured, t: 'Add web search', d: 'Optional. Lets the agent look up current docs and facts.', act: 'Set up', run: () => H.settings('tools') },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!left) return null;
  return h('section', { class: 'd-card checklist', 'aria-label': 'Setup' },
    h('div', { class: 'sec-h' }, h('h2', null, 'Setup'), h('span', { class: 'sec-note num' }, `${steps.length - left} of ${steps.length} done`)),
    h('div', { class: 'cl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(steps.length), 'aria-valuenow': String(steps.length - left) }, h('i', { style: { width: `${((steps.length - left) / steps.length) * 100}%` } })),
    h('ol', { class: 'cl-steps' }, steps.map((s) => h('li', { class: 'cl-step' + (s.done ? ' done' : '') },
      h('span', { class: 'cl-mark', 'aria-hidden': 'true' }, s.done ? icon('check', 12) : null),
      h('span', { class: 'cl-main' }, h('span', { class: 'cl-t' }, s.t), h('span', { class: 'cl-d' }, s.d)),
      !s.done && s.run ? h('button', { class: 'btn sm', type: 'button', onclick: s.run }, s.act) : null))));
}

const footKeys = () => h('div', { class: 'home-keys' }, [['Ctrl+K', 'search'], ['Ctrl+N', 'new session'], ['/', 'slash commands'], ['@', 'mention a file'], ['Esc', 'stop the agent']].map(([k, l]) => h('span', null, kbd(k), ' ', l)));

// ================= first run =================

/** Example tasks under the task box, until there is a history of real ones. A click puts the text in the box. */
const QUICK = ['Explain how this project is put together', 'Find and fix the failing test', 'Review my uncommitted changes for bugs', 'Add tests for the least covered part', 'Write a quick start for the README'];
function quickPrompts(comp) {
  return h('div', { class: 'qp', role: 'group', 'aria-label': 'Example tasks' }, h('span', { class: 'qp-l' }, 'Try'), ...QUICK.map((q) => h('button', { class: 'qp-b', type: 'button', onclick: () => {
    comp.value = q;
    comp.focus();
  } }, q)));
}

/** The providers on the first screen, one tile each; a click opens Settings on that provider's form. */
/** Each provider's mark: a two-letter monogram in the mono voice, no brand colours (colour stays a signal). */
const PV_META = { anthropic: ['An', 'Claude models'], openai: ['Oa', 'GPT and o-series'], google: ['Ge', 'Gemini, free tier'], openrouter: ['Or', 'Sign in, hundreds of models'], ollama: ['Ol', 'Runs on this PC, no key'], lmstudio: ['Lm', 'Runs on this PC, no key'] };
const PV_SUB = Object.fromEntries(Object.entries(PV_META).map(([k, v]) => [k, v[1]]));
function focusProvider(H, id) {
  H.settings('engine');
  const t0 = Date.now();
  const tick = () => {
    const card = document.querySelector(`.pv-card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      card.scrollIntoView({ block: 'center' });
      card.classList.add('flash');
      card.querySelector('.pv-oauth .btn, .pv-key, .pv-url, .btn')?.focus({ preventScroll: true });
    } else if (Date.now() - t0 < 3000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function connectCard(H) {
  const list = (S.engine?.providers || []).filter((p) => p.id in PV_SUB);
  const tiles = list.map((p) => h('button', { class: 'pv-q' + (p.local ? ' local' : '') + (p.configured ? ' on' : ''), type: 'button', title: `Connect ${p.name}`, onclick: () => focusProvider(H, p.id) },
    h('span', { class: 'pv-q-ic', 'aria-hidden': 'true' }, PV_META[p.id][0]),
    h('span', { class: 'pv-q-main' }, h('span', { class: 'pv-q-n' }, p.name), h('span', { class: 'pv-q-s' }, PV_SUB[p.id])),
    p.configured ? h('span', { class: 'dot ok' }) : icon('chevron-right', 14)));
  return h('section', { class: 'd-card connect', 'aria-label': 'Connect a model' },
    h('div', { class: 'd-card-h' }, h('h2', null, 'Providers'), h('span', { class: 'd-card-note' }, 'One API key, or a model on this PC.')),
    h('div', { class: 'pv-quick' }, ...tiles),
    h('div', { class: 'connect-foot' }, h('p', { class: 'setup-note' }, icon('shield', 13), 'Keys are checked with the provider and stored encrypted on this PC.'),
      h('span', { class: 'connect-acts' }, h('button', { class: 'btn ghost sm', type: 'button', onclick: () => H.settings('engine') }, 'All providers'), h('button', { class: 'btn ghost sm', type: 'button', onclick: H.diagnostics }, 'Check my setup'))));
}

/** What the agent does, in six tiles. Orange marks the places you decide; teal what the agent does on its own. */
const FEATURES = [
  ['eye', 'agent', 'Reads your code', 'Files, search and git history, before it changes anything.'],
  ['pencil', 'you', 'Edits with your OK', 'Each change is shown as a diff first. You approve or deny.'],
  ['terminal', 'agent', 'Runs commands', 'Tests, builds and scripts, in WSL or on Windows.'],
  ['undo', 'you', 'Undo any edit', 'The previous version of every file is kept. One click restores it.'],
  ['globe', 'agent', 'Searches the web', 'Reads documentation and looks up facts, when you allow it.'],
  ['plug', '', 'Adds MCP tools', 'Tools from any MCP server. A project’s servers start only after you say so.'],
];
function featuresStrip() {
  return h('section', { class: 'd-feat-sec', 'aria-label': 'What it does' },
    h('div', { class: 'sec-h' }, h('h2', null, 'Capabilities'), h('span', { class: 'sec-note' }, 'Edits and commands wait for your OK.')),
    h('div', { class: 'd-feat' }, ...FEATURES.map(([ic, tone, t, d]) => h('div', { class: 'd-card feat' + (tone ? ' ' + tone : '') }, h('span', { class: 'feat-ic' }, icon(ic, 16)), h('span', { class: 'feat-t' }, t), h('span', { class: 'feat-d' }, d)))));
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
  const st = h('span', { class: 'demo-st' }, 'preview');
  const el = h('div', { class: 'demo', 'aria-hidden': 'true' },
    h('div', { class: 'demo-bar' }, h('span', { class: 'dot' }), h('span', null, 'Preview'), st),
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
    show('', 'preview');
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

// ================= dashboard =================
// Every number here is read from real state: the saved conversations (S.sessions: title, cwd, mtime, size),
// the open tabs (working / waiting on you), the configured providers and the shell backend. Nothing is invented.

const DAY = 864e5;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? Math.round(n / 1e3) + ' KB' : (n || 0) + ' B');
const clockText = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
let clockTimer = 0;
function tickClock() {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    const els = document.querySelectorAll('.d-clock');
    if (!els.length) { clearInterval(clockTimer); clockTimer = 0; return; }
    for (const el of els) el.textContent = clockText();
  }, 15000);
}

/**
 * A KPI numeral that rolls from its last shown value to the new one (from 0 the first time Home opens).
 * Redraws with an unchanged value render it still, so the strip never twitches while you type.
 */
const shown = new Map();
function countUp(key, text) {
  const el = h('span', { class: 'd-kpi-v num' + (/^0(\D|$)/.test(text) || text === '–' ? ' zero' : '') }, text);
  const m = /^(\d+(?:\.\d+)?)(.*)$/.exec(text);
  const to = m ? parseFloat(m[1]) : NaN;
  key = `${key}|${m ? m[2] : ''}`; // a unit change (KB to MB) starts a fresh roll rather than counting across units
  const prev = shown.get(key);
  const from = Number.isFinite(prev) ? prev : 0;
  if (Number.isFinite(to)) shown.set(key, to);
  else shown.delete(key);
  if (!m || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) return el;
  const dec = (m[1].split('.')[1] || '').length;
  const t0 = performance.now();
  const dur = 900;
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 4);
    el.textContent = (from + (to - from) * e).toFixed(dec) + m[2];
    if (p < 1 && el.isConnected !== false) requestAnimationFrame(step);
  };
  el.textContent = from.toFixed(dec) + m[2];
  requestAnimationFrame(step);
  return el;
}

function liveTabs() {
  const live = [...S.tabs.values()].filter((t) => !t.dead);
  return { live, working: live.filter((t) => t.streaming), waiting: live.filter((t) => t.dialogs.some(isApproval)) };
}

/**
 * The emblem: the live mark on a tile with an instrument reticle (two rings, four ticks) behind it. It never follows
 * the pointer; nothing moves under prefers-reduced-motion.
 */
let HEAD = null; // the persistent header: { el, left }
let FIRST = null; // the persistent first-run wrapper
let EMBLEM = null; // built once: Home redraws reuse it, so the orbit never restarts mid-turn
function emblem() {
  return (EMBLEM ||= buildEmblem());
}
function buildEmblem() {
  const NS = 'http://www.w3.org/2000/svg';
  const reticle = document.createElementNS(NS, 'svg');
  reticle.setAttribute('class', 'd-reticle');
  reticle.setAttribute('viewBox', '0 0 100 100');
  reticle.setAttribute('aria-hidden', 'true');
  reticle.innerHTML = '<circle cx="50" cy="50" r="44" /><circle cx="50" cy="50" r="31" class="in" />'
    + '<path d="M50 2v6M50 92v6M2 50h6M92 50h6" class="tk" />';
  // Autonomous: the mark moves on its own (the orbit), never with the pointer.
  return h('span', { class: 'd-emblem hero-mark', 'aria-hidden': 'true' }, reticle, logo(50, { alive: true }));
}

/** Header: date and clock as an instrument line, the greeting, and the system readout on the right. */
function dashHead(H, g) {
  tickClock();
  const on = S.engine?.providers?.filter((p) => p.configured) || [];
  const b = S.env?.backend;
  const auto = S.engine?.approvals === 'auto';
  const ready = engineReady();
  const chip = (k, v, tone, title, onclick) => h('button', { class: 'd-chip' + (tone ? ' ' + tone : ''), type: 'button', title, onclick }, h('span', { class: 'd-chip-dot', 'aria-hidden': 'true' }), h('span', { class: 'd-chip-k' }, k), h('span', { class: 'd-chip-v ell' }, v));
  const m = homeModel();
  // The header element and its emblem persist across redraws (re-inserting them would restart the logo's orbit);
  // only the text column is rebuilt.
  HEAD ||= { el: null, left: h('div', { class: 'd-head-l' }) };
  HEAD.el ||= h('header', { class: 'd-head' }, emblem(), HEAD.left, h('div', { class: 'd-art', 'aria-hidden': 'true' }));
  HEAD.left.replaceChildren(
      h('div', { class: 'd-line' }, h('span', null, greeting()), h('span', { class: 'd-sep' }, '/'), h('span', { class: 'd-clock num' }, clockText()), ...(g ? [h('span', { class: 'd-sep' }, '/'), h('span', { class: 'd-proj ell', title: g.path }, g.name)] : [])),
      h('h1', { class: 'd-h' }, g ? g.name : 'Workspace'),
      h('p', { class: 'd-sub' }, !ready ? 'No model connected. Choose a provider to start.' : S.sessions.length ? 'Resume a session, or describe a new task.' : 'Describe a task. The agent asks before it changes anything.'),
      !ready ? '' : h('div', { class: 'd-head-r', role: 'group', 'aria-label': 'System' },
        chip('Agent', ready ? (m ? m.name || m.id : on[0]?.name || 'Ready') : 'No provider', ready ? 'ok' : 'warn', 'Your model provider. Click to change.', () => H.settings('engine')),
        chip('Approvals', auto ? 'Off' : 'Ask first', auto ? 'warn' : 'ok', 'Whether edits and commands wait for your OK. Click to change.', () => H.settings('behavior')),
        b ? chip('Shell', b.kind === 'wsl' ? (b.distro ? `WSL · ${b.distro}` : 'WSL') : 'Windows', '', 'Where the agent runs commands. Click to change.', () => H.settings('behavior')) : null));
  return HEAD.el;
}

/** Beside the launch panel: what is happening now, in large numerals, with each open session listed. */
function nowCard(H) {
  const { live, working, waiting } = liveTabs();
  const rows = live.slice(0, 4).map((t) => {
    const wait = t.dialogs.some(isApproval);
    const st = wait ? 'wait' : t.streaming ? 'run' : 'open';
    const s = S.sessions.find((x) => tabForSession(x) === t);
    return h('button', { class: `rc d-live ${st}`, type: 'button', onclick: () => (s ? H.openSession(s) : setActive(t.id)) },
      h('span', { class: 'rc-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'ell grow' }, s?.title || t.title || baseName(t.workspace || '') || 'Session'),
      h('span', { class: 'd-live-st' }, wait ? 'needs you' : t.streaming ? 'working' : 'idle'));
  });
  const stat = (n, l, cls) => h('div', { class: 'd-now-stat ' + cls + (n ? ' lit' : '') }, h('span', { class: 'd-num num' }, String(n)), h('span', { class: 'd-lab' }, l));
  return h('section', { class: 'd-card d-now' + (working.length ? ' live' : '') + (waiting.length ? ' wait' : ''), 'aria-label': 'Queue' },
    h('div', { class: 'd-card-h' }, h('h2', null, 'Queue'), h('span', { class: 'd-pulse' + (working.length ? ' on' : '') }, working.length ? 'Live' : 'Idle')),
    h('div', { class: 'd-now-stats' }, stat(working.length, 'working', 'run'), stat(waiting.length, 'need you', 'wait'), stat(live.length, 'open', 'open')),
    rows.length ? h('div', { class: 'd-live-list' }, ...rows) : h('p', { class: 'd-empty' }, 'Nothing running. Start a session, or reopen one from Recent.'));
}

/** Four numbers that describe the workspace, each with its own comparison or detail line. */
function kpis(projects) {
  const now = Date.now();
  const ss = S.sessions;
  const wk = ss.filter((s) => s.mtime > now - 7 * DAY).length;
  const prev = ss.filter((s) => s.mtime <= now - 7 * DAY && s.mtime > now - 14 * DAY).length;
  const today = ss.filter((s) => s.mtime >= startOfDay(now)).length;
  const bytes = ss.reduce((a, s) => a + (s.size || 0), 0);
  const delta = wk - prev;
  const top = [...projects].sort((a, b) => b.sessions.length - a.sessions.length)[0];
  const tile = (k, v, foot, tone) => h('div', { class: 'd-kpi' }, h('span', { class: 'd-lab' }, k), countUp(k, v), h('span', { class: 'd-kpi-f' + (tone ? ' ' + tone : '') }, foot));
  return h('section', { class: 'd-kpis', 'aria-label': 'Overview' },
    tile('Conversations', String(ss.length), today ? `${today} active today` : 'none active today'),
    tile('Last 7 days', String(wk), prev || wk ? `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${Math.abs(delta)} vs the week before` : 'no activity yet', delta > 0 ? 'up' : delta < 0 ? 'down' : ''),
    tile('Projects', String(projects.length), top ? `most active: ${top.name}` : 'open a folder to start'),
    tile('Transcripts', bytes ? fmtBytes(bytes) : '–', bytes ? 'stored on this PC' : 'nothing saved yet'));
}

/** 16 weeks of activity: one cell per day, shaded by how many conversations were last active that day. */
function activityCard() {
  const WEEKS = 16;
  const today = startOfDay(Date.now());
  const dow = (new Date(today).getDay() + 6) % 7; // Monday first
  const start = today - (WEEKS * 7 - 1 - (6 - dow)) * DAY;
  const counts = new Map();
  for (const s of S.sessions) { const d = startOfDay(s.mtime); if (d >= start) counts.set(d, (counts.get(d) || 0) + 1); }
  const max = Math.max(1, ...counts.values());
  const cells = [];
  let active = 0, best = 0, run = 0, streak = 0;
  // Column-major: each column is a week (Mon..Sun), matching the grid's auto-flow.
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = start + i * DAY;
    const n = counts.get(d) || 0;
    const future = d > today;
    if (!future) { if (n) { active++; run++; best = Math.max(best, run); } else run = 0; }
    const lvl = future ? 'x' : n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    cells.push(h('i', { class: `hm l${lvl}` + (d === today ? ' today' : ''), title: future ? '' : `${new Date(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${n} conversation${n === 1 ? '' : 's'}` }));
  }
  for (let d = today; (counts.get(d) || 0) > 0; d -= DAY) streak++;
  const months = [];
  for (let w = 0; w < WEEKS; w++) {
    const m = new Date(start + w * 7 * DAY).getMonth();
    const pm = w ? new Date(start + (w - 1) * 7 * DAY).getMonth() : -1;
    months.push(h('span', null, m !== pm ? new Date(start + w * 7 * DAY).toLocaleDateString(undefined, { month: 'short' }) : ''));
  }
  const cols = { gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` };
  return h('section', { class: 'd-card d-act', 'aria-label': 'Activity' },
    h('div', { class: 'd-card-h' }, h('h2', null, 'Activity'), h('span', { class: 'hm-key', 'aria-hidden': 'true' }, 'less', ...[0, 1, 2, 3, 4].map((l) => h('i', { class: `hm l${l}` })), 'more')),
    h('div', { class: 'hm-wrap' },
      h('div', { class: 'hm-days', 'aria-hidden': 'true' }, ...['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].map((x) => h('span', null, x))),
      h('div', { class: 'hm-body' }, h('div', { class: 'hm-months', 'aria-hidden': 'true', style: cols }, ...months), h('div', { class: 'hm-grid', style: cols }, ...cells))),
    h('div', { class: 'd-act-foot' },
      h('span', null, h('b', { class: 'num' }, String(active)), ' active days'),
      h('span', null, h('b', { class: 'num' }, String(streak)), ' day streak'),
      h('span', null, h('b', { class: 'num' }, String(best)), ' best run'),
      h('span', { class: 'd-act-span' }, `last ${WEEKS} weeks`)));
}

/** Projects by last activity, with their share of conversations as a bar. Clicking one aims the next session there. */
function projectsCard(H, projects) {
  const last = (g) => Math.max(0, ...g.sessions.map((s) => s.mtime || 0));
  const list = [...projects].sort((a, b) => last(b) - last(a)).slice(0, 6);
  const most = Math.max(1, ...list.map((g) => g.sessions.length));
  const pick = (g) => {
    draft.project = g.path;
    drawHome(document.getElementById('welcome'), H);
    C?.comp.focus();
  };
  return h('section', { class: 'd-card d-projs', 'aria-label': 'Projects' },
    h('div', { class: 'd-card-h' }, h('h2', null, 'Projects'), h('button', { class: 'link', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 13), 'Open folder')),
    list.length ? h('div', { class: 'd-proj-list' }, ...list.map((g) => {
      const live = g.sessions.map(tabForSession).filter((t) => t && !t.dead);
      const st = live.some((t) => t.dialogs.some(isApproval)) ? 'warn' : live.some((t) => t.streaming) ? 'run' : '';
      const cur = g.path === draft.project;
      // Before a model is connected there is no composer to aim, so the row is a plain readout rather than a dead button.
      const start = C ? { type: 'button', title: `Start the next session in ${g.path}`, onclick: () => pick(g) } : { title: g.path };
      return h(C ? 'button' : 'div', { class: 'd-proj-row' + (cur ? ' cur' : '') + (C ? '' : ' static'), ...start },
        h('span', { class: 'd-proj-top' }, icon(cur ? 'folder-open' : 'folder', 14), h('span', { class: 'd-proj-n ell' }, g.name), st ? h('span', { class: `dot ${st}` }) : null, h('span', { class: 'grow' }), h('span', { class: 'd-proj-c num' }, `${g.sessions.length}`), h('span', { class: 'd-proj-w num' }, last(g) ? timeAgo(last(g)) : '–')),
        h('span', { class: 'd-bar', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.max(3, (g.sessions.length / most) * 100)}%` } })));
    })) : h('div', { class: 'd-empty-box' }, h('span', { class: 'empty-ico' }, icon('folder', 16)), h('p', null, 'No projects yet. The agent only works inside folders you open.'), h('button', { class: 'btn sm', type: 'button', onclick: () => H.openFolder() }, icon('folder-plus', 14), 'Open a project folder')));
}

/** Recent conversations with their live state in the two signals. */
function recentCard(H, n = 5) {
  const rows = S.sessions.slice(0, n).map((s) => {
    const open = tabForSession(s);
    const waiting = open && open.dialogs.some(isApproval);
    const state = waiting ? 'wait' : open?.streaming ? 'run' : open ? 'open' : 'idle';
    return h('button', { class: `rc ${state}`, type: 'button', title: s.preview || s.title, onclick: () => H.openSession(s) },
      h('span', { class: 'rc-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'rc-main' }, h('span', { class: 'rc-t ell' }, s.title), h('span', { class: 'rc-f' }, h('span', { class: 'ell' }, baseName(s.cwdDisplay || s.cwd)))),
      waiting ? h('span', { class: 'rc-pill' }, 'Needs you') : open?.streaming ? h('span', { class: 'rc-w live' }, 'working') : h('span', { class: 'rc-w num' }, open ? 'open' : timeAgo(s.mtime)));
  });
  return h('section', { class: 'd-card d-recent', 'aria-label': 'Sessions' },
    h('div', { class: 'd-card-h' }, h('h2', null, 'Sessions'), rows.length ? h('button', { class: 'link', type: 'button', onclick: H.manage }, 'Manage') : null),
    rows.length ? h('div', { class: 'rc-list' }, ...rows) : h('div', { class: 'd-empty-box' }, h('span', { class: 'empty-ico' }, icon('message', 16)), h('p', null, 'Conversations appear here. Each one is saved and can be resumed.')));
}
