// Automations (sidebar → Automations): prompts ORBIX sends by itself on a schedule, each as a new conversation in
// its project. The page lists them with their next and last run, and has a form to add or change one.
import { h, icon, replace, toast, baseName, timeAgo, errorState, skeleton } from './dom.js';
import { api } from './api.js';
import { S, emit, groupSessions } from './store.js';
import { btn, confirmDialog, toggle } from './dialogs.js';

let items = null;
let error = '';
let loading = false;
let form = null; // the automation being added or changed: { id?, name, prompt, project, schedule, enabled }
let host = null;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EVERY = [['hour', 'Every hour'], ['day', 'Every day'], ['weekday', 'Weekdays'], ['week', 'Every week']];

async function load() {
  loading = true;
  try {
    items = (await api.get('/api/automations')).items;
    error = '';
  } catch (e) {
    error = e.message;
  }
  loading = false;
  if (host?.isConnected) drawAutomations(host);
}

/** "Today 09:00", "Tomorrow 09:00", "Mon 09:00", or a date. */
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const projects = () => {
  const seen = new Map();
  for (const g of groupSessions()) if (g.path) seen.set(g.path, g.name);
  for (const w of S.workspaces || []) seen.set(w.path, w.name || baseName(w.path));
  return [...seen.entries()];
};

async function save(data) {
  try {
    items = (await api.post('/api/automations', data)).items;
    form = null;
    toast(data.id ? 'Saved' : 'Automation added', 'ok', 1400);
  } catch (e) {
    toast(e.message, 'error');
  }
  drawAutomations(host);
}

function editor() {
  const f = form;
  const s = f.schedule || { every: 'day', hour: 9, minute: 0 };
  const list = projects();
  const name = h('input', { type: 'text', value: f.name || '', placeholder: 'Name (optional)', 'aria-label': 'Name', maxlength: 80 });
  const prompt = h('textarea', { rows: 4, placeholder: 'What should it do? For example: run the tests and tell me what fails, with a fix for each.', 'aria-label': 'What it should do' }, f.prompt || '');
  const project = h('select', { 'aria-label': 'Project' }, list.length ? list.map(([p, n]) => h('option', { value: p, selected: p === f.project }, `${n} · ${p}`)) : h('option', { value: '' }, 'Open a project folder first'));
  const every = h('select', { 'aria-label': 'How often' }, EVERY.map(([v, l]) => h('option', { value: v, selected: v === s.every }, l)));
  const day = h('select', { 'aria-label': 'Day' }, DAYS.map((d, i) => h('option', { value: String(i), selected: i === (s.day ?? 1) }, d)));
  const time = h('input', { type: 'time', value: `${String(s.hour ?? 9).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`, 'aria-label': 'Time' });
  const minute = h('input', { type: 'number', min: 0, max: 59, value: String(s.minute ?? 0), 'aria-label': 'Minute past the hour' });
  const dayWrap = h('label', { class: 'au-f' }, h('span', null, 'Day'), day);
  const timeWrap = h('label', { class: 'au-f' }, h('span', null, 'At'), time);
  const minWrap = h('label', { class: 'au-f' }, h('span', null, 'Minute past the hour'), minute);
  const sync = () => {
    dayWrap.hidden = every.value !== 'week';
    timeWrap.hidden = every.value === 'hour';
    minWrap.hidden = every.value !== 'hour';
  };
  every.addEventListener('change', sync);
  sync();
  const m = S.ui.homeModel;
  const submit = () => {
    const [hh, mm] = (time.value || '09:00').split(':').map(Number);
    const sched = every.value === 'hour' ? { every: 'hour', minute: Math.max(0, Math.min(59, Number(minute.value) || 0)) } : { every: every.value, hour: hh, minute: mm, ...(every.value === 'week' ? { day: Number(day.value) } : {}) };
    return save({ id: f.id, name: name.value, prompt: prompt.value, project: project.value, schedule: sched, enabled: f.enabled !== false, model: f.model || (m ? `${m.provider}/${m.id}` : '') });
  };
  setTimeout(() => prompt.focus(), 0);
  return h('section', { class: 'au-form', 'aria-label': f.id ? 'Change automation' : 'New automation' },
    h('h2', null, f.id ? 'Change automation' : 'New automation'),
    name, prompt,
    h('div', { class: 'au-row' }, h('label', { class: 'au-f grow' }, h('span', null, 'Project'), project), h('label', { class: 'au-f' }, h('span', null, 'How often'), every), dayWrap, timeWrap, minWrap),
    h('p', { class: 'muted small' }, `Uses ${f.model ? f.model.split('/').slice(1).join('/') : m ? m.name || m.id : 'the default model'}. Runs while ORBIX is open; a time missed while it was closed is skipped.`),
    h('div', { class: 'au-acts' }, btn(f.id ? 'Save' : 'Add automation', submit, 'primary'), btn('Cancel', () => ((form = null), drawAutomations(host)))));
}

function row(a) {
  const status = a.running ? h('span', { class: 'run-pill live' }, h('span', { class: 'dot run' }), 'Running') : a.lastStatus?.startsWith('failed') ? h('span', { class: 'run-pill err', title: a.lastStatus }, 'Last run failed') : null;
  const enabled = toggle(a.enabled, async (v) => {
    try {
      items = (await api.post('/api/automations', { ...a, enabled: v })).items;
    } catch (e) {
      toast(e.message, 'error');
    }
    drawAutomations(host);
  }, a.enabled ? 'Turn off' : 'Turn on');
  const open = a.running && S.tabs.has(a.lastProc) ? btn('Open', () => emit('open-tab', a.lastProc), 'sm') : null;
  return h('article', { class: 'au-item' + (a.enabled ? '' : ' off') },
    h('div', { class: 'au-main' },
      h('div', { class: 'au-title' }, icon('clock', 15), h('strong', { class: 'ell', title: a.name }, a.name), status),
      h('div', { class: 'au-meta' }, h('span', null, a.when), h('span', null, icon('folder', 12), baseName(a.project)), a.enabled && a.nextAt ? h('span', null, `Next: ${when(a.nextAt)}`) : h('span', null, 'Off'), a.lastRun ? h('span', { title: a.lastStatus }, `Last: ${timeAgo(a.lastRun)}${/^\d/.test(timeAgo(a.lastRun)) ? ' ago' : ''}`) : null),
      a.prompt.trim() !== a.name.trim() ? h('p', { class: 'au-prompt' }, a.prompt) : null),
    h('div', { class: 'au-side' },
      enabled,
      h('div', { class: 'au-acts' },
        open,
        btn('Run now', async () => {
          try {
            items = (await api.post('/api/automations/run', { id: a.id })).items;
            toast('Started. It opens as a new conversation.', 'ok', 2200);
          } catch (e) {
            toast(e.message, 'error');
          }
          drawAutomations(host);
        }, 'sm'),
        btn('Edit', () => ((form = { ...a }), drawAutomations(host)), 'sm'),
        btn('Delete', async () => {
          if (!(await confirmDialog('Delete automation', `Delete “${a.name}”? Conversations it already started stay.`, { ok: 'Delete', danger: true }))) return;
          items = (await api.post('/api/automations/delete', { id: a.id }).catch((e) => (toast(e.message, 'error'), { items }))).items;
          drawAutomations(host);
        }, 'sm danger'))));
}

/** Draw the page into `root` (the hub section). */
export function drawAutomations(root) {
  host = root;
  if (!items && !loading && !error) load();
  const ask = (S.engine?.approvals || 'ask') !== 'auto';
  const keepForm = root.querySelector('.au-form');
  if (form && keepForm && root.firstChild?.classList?.contains('hub')) {
    // A redraw while you edit keeps the form as it is; only the list below it changes.
    const list = root.querySelector('.au-list');
    if (list) replace(list, (items || []).map(row));
    return;
  }
  replace(root,
    h('div', { class: 'hub' },
      h('header', { class: 'hub-head' },
        h('h1', null, 'Automations'),
        h('p', { class: 'muted' }, 'Tasks that ORBIX starts by itself on a schedule, each as a new conversation in its project.'),
        form ? null : btn('New automation', () => ((form = { enabled: true, project: projects()[0]?.[0] || '' }), drawAutomations(root)), 'primary au-new')),
      ask ? h('p', { class: 'au-note' }, icon('shield', 13), 'With Ask first or Auto edits, a run waits for your OK on commands. Review lists what it waits for.') : null,
      form ? editor() : null,
      error ? errorState(error, { retry: () => ((error = ''), load()) }) : !items ? skeleton(3) : !items.length && !form ? h('div', { class: 'empty' }, icon('clock', 22), h('span', null, 'No automations yet.'), h('span', { class: 'small' }, 'For example: every weekday at 09:00, “run the tests and tell me what fails”.')) : h('div', { class: 'au-list' }, items.map(row))));
}

/** Refresh the list (another window changed it, or a run started or ended). */
export function refreshAutomations() {
  if (host?.isConnected) load();
}
