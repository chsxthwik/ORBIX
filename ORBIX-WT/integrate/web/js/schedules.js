// Scheduled runs, shown in the Runs view: tasks ORBIX starts by itself at set times, unattended, each in its own
// worktree. The list (on/off, run now, delete, next time, last result) and the dialog that makes a schedule.
// The server side is src/schedule.mjs; `/schedule` in a conversation makes one too.
import { h, icon, toast, timeAgo, baseName } from './dom.js';
import { api } from './api.js';
import { S } from './store.js';
import { modal, btn, confirmDialog } from './dialogs.js';

const items = new Map(); // id -> schedule (as the server sends it)
let loaded = false;
let loading = null;
let loadError = '';
let redraw = () => {};

const post = (url, body) => api.post(url, body).catch((e) => (toast(e.message, 'error', 9000), Promise.reject(e)));

/** `onChange` redraws the view that shows the list. */
export function initSchedules(onChange) {
  redraw = onChange || redraw;
}

function load() {
  loading ||= api
    .get('/api/schedules')
    .then((j) => {
      items.clear();
      for (const s of j.schedules) items.set(s.id, s);
      loaded = true;
      loadError = '';
    })
    .catch((e) => (loadError = e.message))
    .finally(() => {
      loading = null;
      redraw();
    });
  return loading;
}

/** A schedule changed on the server, or was removed. */
export function onScheduleEvent(g) {
  if (g.g === 'schedule_removed') items.delete(g.id);
  else if (g.schedule) items.set(g.schedule.id, g.schedule);
  redraw();
}

const pad = (n) => String(n).padStart(2, '0');
function stamp(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  const tom = new Date(now);
  tom.setDate(now.getDate() + 1);
  if (d.toDateString() === tom.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

// ---- Making a schedule -----------------------------------------------------------------------------------------------

function newScheduleDialog() {
  const projects = S.workspaces || [];
  if (!projects.length) return toast('Open a project folder first (the folder button in the sidebar).', 'warn');
  const last = localStorage.getItem('orbix.run.project') || '';
  let project = projects.find((p) => p.path === last)?.path || projects[0].path;
  let kind = 'daily';
  let mode = 'plan';
  let commands = false;
  const task = h('textarea', { rows: '3', placeholder: 'What should the run do each time? For example: run the tests and fix any failures', 'aria-label': 'Task' });
  const time = h('input', { type: 'time', value: '09:00', 'aria-label': 'Time' });
  const count = h('input', { type: 'number', min: '1', max: '168', value: '2', 'aria-label': 'Interval' });
  const unit = h('select', { 'aria-label': 'Unit' }, h('option', { value: 'h' }, 'hours'), h('option', { value: 'm' }, 'minutes'));
  const soon = new Date(Date.now() + 60 * 60_000);
  const at = h('input', { type: 'datetime-local', 'aria-label': 'Date and time', value: `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00` });
  const whenBox = h('div', { class: 'sched-when-in' });
  const showWhen = () => {
    whenBox.replaceChildren(...(kind === 'every' ? [h('span', { class: 'muted' }, 'every'), count, unit] : kind === 'once' ? [at] : [h('span', { class: 'muted' }, 'at'), time]));
  };
  showWhen();
  const kindSel = h('select', { 'aria-label': 'Repeat', onchange: (e) => ((kind = e.target.value), showWhen()) },
    h('option', { value: 'daily' }, 'Daily'), h('option', { value: 'weekdays' }, 'Weekdays (Mon–Fri)'), h('option', { value: 'every' }, 'Every…'), h('option', { value: 'once' }, 'Once'));
  const seg = (val, label, tip) => h('button', { class: 'rseg-btn' + (mode === val ? ' on' : ''), type: 'button', title: tip, 'aria-pressed': String(mode === val), onclick: (e) => {
    mode = val;
    for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget), b.setAttribute('aria-pressed', String(b === e.currentTarget));
  } }, label);
  const choice = (val, title, text) =>
    h('label', { class: 'scope-opt' },
      h('input', { type: 'radio', name: 'sched-scope', checked: val === commands ? true : null, onchange: () => (commands = val) }),
      h('span', null, h('b', null, title), h('span', { class: 'muted small' }, text)));

  function recurrence() {
    if (kind === 'daily' || kind === 'weekdays') return { kind, time: time.value };
    if (kind === 'every') {
      const n = Number(count.value);
      return { kind, minutes: unit.value === 'h' ? n * 60 : n };
    }
    const t = new Date(at.value).getTime(); // datetime-local is read as local time
    return { kind: 'once', at: Number.isFinite(t) ? t : 0 };
  }

  const m = modal({
    title: 'Schedule a run',
    size: 'md',
    body: h('div', { class: 'scope sched-form' },
      h('label', { class: 'field' }, h('span', null, 'Project'),
        h('select', { onchange: (e) => (project = e.target.value) }, projects.map((p) => h('option', { value: p.path, selected: p.path === project ? true : null }, `${p.name || baseName(p.path)}  ·  ${p.path}`)))),
      h('label', { class: 'field' }, h('span', null, 'Task'), task),
      h('div', { class: 'field' }, h('span', null, 'When'), h('div', { class: 'sched-when' }, kindSel, whenBox)),
      h('div', { class: 'field' }, h('span', null, 'How each run starts'),
        h('div', { class: 'rseg', role: 'group', 'aria-label': 'How each run starts' },
          seg('plan', 'Plan first', 'The agent reads and writes a plan; the plan is approved for you with the scope below.'),
          seg('direct', 'Straight to work', 'The agent starts changing files in the worktree right away, within the scope below.'))),
      h('fieldset', { class: 'scope-pick' }, h('legend', null, 'Allowed without asking (fixed for every run)'),
        choice(false, 'Edit files in the worktree', 'Commands are denied, except ones you marked as trusted.'),
        choice(true, 'Edit files and run commands in the worktree', 'Tests, builds and other commands run.')),
      h('p', { class: 'scope-note' }, icon('shield', 14), h('span', null, 'Nobody is there to answer, so anything that would ask you is denied and shown in the run’s log: files outside the worktree, commands that delete folders, push, publish, rewrite history or change the system, and anything beyond the scope above. The changes wait for you in Review; nothing is applied for you.')),
      h('p', { class: 'muted small' }, 'Runs while ORBIX is open, by this computer’s clock. A time missed while ORBIX was closed runs once when it starts again. A time is skipped while the last run is still working.')),
    actions: [btn('Cancel', () => m.close()), btn('Create schedule', async () => {
      const text = task.value.trim();
      if (!text) return task.focus();
      try {
        const j = await api.post('/api/schedules/create', { project, task: text, recurrence: recurrence(), mode, commands });
        items.set(j.schedule.id, j.schedule);
        localStorage.setItem('orbix.run.project', project);
        m.close();
        toast(`Scheduled: ${j.schedule.describe}. Next run ${stamp(j.schedule.nextAt)}.`, 'ok');
        redraw();
      } catch (e) {
        toast(e.message, 'error', 9000);
      }
    }, 'primary')],
    initialFocus: task,
  });
}

// ---- The list --------------------------------------------------------------------------------------------------------

function lastLine(s, ctx) {
  const run = s.lastRunId ? ctx.runs.get(s.lastRunId) : null;
  const top = s.history?.[0];
  if (top?.skipped && (!s.lastAt || top.at >= s.lastAt)) return h('span', { class: 'muted' }, `Skipped ${timeAgo(top.at)}: ${top.skipped}`);
  if (s.lastError) return h('span', { class: 'sched-err' }, icon('alert', 12), `Did not start ${timeAgo(s.lastAt)}: ${s.lastError}`);
  if (!s.lastRunId) return h('span', { class: 'muted' }, 'Not run yet');
  const status = run?.status || s.lastRunStatus;
  return h('button', { class: 'sched-last', type: 'button', title: 'Open the run', disabled: run ? null : true, onclick: () => run && ctx.openRun(run.id) },
    'Last run ', timeAgo(s.lastAt), top?.missed && top.run === s.lastRunId ? ' (missed while closed)' : '', ' ', status && status !== 'removed' ? ctx.pill(status) : h('span', { class: 'muted' }, '· removed'));
}

function scheduleRow(s, ctx) {
  // The run list is updated live; the schedule is only sent again when it changes, so the run decides "working".
  const run = s.lastRunId ? ctx.runs.get(s.lastRunId) : null;
  const running = run ? ctx.isWorking(run.status) : s.running;
  const toggle = h('input', { type: 'checkbox', role: 'switch', checked: s.enabled ? true : null, 'aria-label': s.enabled ? 'Turn off' : 'Turn on', onchange: async (e) => {
    const on = e.target.checked;
    try {
      const j = await api.post('/api/schedule/enable', { id: s.id, enabled: on });
      items.set(s.id, j.schedule);
    } catch (err) {
      e.target.checked = !on;
      toast(err.message, 'error', 9000);
    }
    redraw();
  } });
  return h('div', { class: 'sched-row' + (s.enabled ? '' : ' off') },
    h('label', { class: 'switch', title: s.enabled ? 'On: turn off' : 'Off: turn on' }, toggle, h('i')),
    h('div', { class: 'sched-main' },
      h('span', { class: 'run-title ell', title: s.task }, s.title),
      h('span', { class: 'run-meta ell' }, icon('clock', 12), s.describe, icon('folder', 12), baseName(s.project), s.scope?.commands ? h('span', { class: 'muted' }, '· edits and commands') : h('span', { class: 'muted' }, '· edits only'), s.mode === 'direct' ? h('span', { class: 'muted' }, '· no plan') : null),
      h('span', { class: 'run-meta sched-status' },
        running ? h('span', { class: 'run-pill live' }, h('span', { class: 'dot run' }), 'Working') : s.enabled && s.nextAt ? h('span', null, 'Next ', h('b', { class: 'num' }, stamp(s.nextAt))) : h('span', { class: 'muted' }, s.recurrence?.kind === 'once' && s.lastRunId ? 'Done' : 'Off'),
        h('span', { class: 'sched-sep' }, '·'),
        lastLine(s, ctx))),
    h('div', { class: 'sched-acts' },
      btn('Run now', async () => {
        const j = await post('/api/schedule/run', { id: s.id }).catch(() => null);
        if (!j) return;
        items.set(s.id, j.schedule);
        toast('Started an unattended run', 'ok');
        redraw();
      }, 'sm'),
      btn('Delete', async () => {
        if (!(await confirmDialog('Delete this schedule?', `"${s.title}" will not run again. Runs it already started stay in Runs.`, { ok: 'Delete', danger: true }))) return;
        await post('/api/schedule/delete', { id: s.id }).catch(() => {});
        items.delete(s.id);
        redraw();
      }, 'ghost sm danger')));
}

/**
 * The Scheduled section of the Runs view. ctx: { runs (id -> run), openRun(id), pill(status), isWorking(status) }
 * from runs.js.
 */
export function schedulesSection(ctx) {
  if (!loaded && !loading && !loadError) load();
  const list = [...items.values()].sort((a, b) => (a.enabled === b.enabled ? (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) : a.enabled ? -1 : 1));
  return h('section', { class: 'run-group sched', 'aria-label': 'Scheduled runs' },
    h('div', { class: 'sched-head' },
      h('h2', null, 'Scheduled', list.length ? h('span', { class: 'num muted' }, list.length) : null),
      h('span', { class: 'grow' }),
      btn('New schedule…', () => newScheduleDialog(), 'sm')),
    loadError ? h('p', { class: 'sched-err small' }, `Could not load schedules: ${loadError} `, btn('Retry', () => ((loadError = ''), load()), 'ghost sm')) :
      !loaded ? h('p', { class: 'muted small' }, 'Loading…') :
        !list.length ? h('p', { class: 'muted small' }, 'Nothing scheduled. A schedule starts a run by itself at set times, unattended. Or type /schedule daily 09:00 <task> in a conversation.') :
          list.map((s) => scheduleRow(s, ctx)));
}
