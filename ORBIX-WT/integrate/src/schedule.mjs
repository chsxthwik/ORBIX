// Schedules: a task that ORBIX starts as an unattended run at set times, while ORBIX is open.
//
//   data/schedules.json   every schedule (rewritten atomically): project, task, when, scope, on/off, what happened
//
// A schedule starts an ordinary run (its own worktree and branch, src/runctl.mjs) marked unattended: its plan is
// approved with the scope you picked when you made the schedule, and anything that would ask you is denied and
// written to the run's log instead (engine/policy.mjs). The changes wait for you in Review; nothing is applied for you.
//
// Timing rules:
//   - Times are the computer's local time. "daily 09:00" follows the clock across daylight-saving changes.
//   - ORBIX checks every 15 seconds, so a run starts up to that long after its time.
//   - Missed while ORBIX was closed: on start-up a schedule that is overdue runs once (however many times it was
//     missed), then continues from its next time after now.
//   - One run at a time per schedule: when the time comes while the last run is still working, that time is skipped
//     (and noted), never queued.
//   - A one-off ("once") schedule switches itself off after it starts its run.
import crypto from 'node:crypto';
import { readJson, writeJson, clip, log } from './util.mjs';
import { WORKING } from './runs.mjs';

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const MIN_EVERY = 5; // minutes: shorter intervals would start runs faster than a run can finish
const MAX_EVERY = 7 * 24 * 60;
const MAX_TASK = 8000;
const HISTORY = 20;
const ID_RE = /^s[0-9a-z]{6,40}$/;
export const TICK_MS = 15_000;

// ---- Recurrence ------------------------------------------------------------------------------------------------------

/** "9:05" or "09:05" -> "09:05"; null when it is not a 24-hour time. */
export function parseTime(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(text || '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/**
 * A checked copy of a recurrence, or an error saying what is wrong. Kinds:
 *   { kind: 'once', at }                     one time (ms since the epoch)
 *   { kind: 'every', minutes, anchor }       every N minutes, counted from `anchor` (when the schedule was made)
 *   { kind: 'daily', time: 'HH:MM' }         every day at that local time
 *   { kind: 'weekdays', time: 'HH:MM' }      Monday to Friday at that local time
 */
export function normalizeRecurrence(rec, now = Date.now()) {
  const r = rec && typeof rec === 'object' ? rec : {};
  switch (r.kind) {
    case 'once': {
      const at = Number(r.at);
      if (!Number.isFinite(at) || at <= 0) throw bad('Choose the date and time for the run.');
      return { kind: 'once', at };
    }
    case 'every': {
      const minutes = Math.round(Number(r.minutes));
      if (!Number.isFinite(minutes) || minutes < MIN_EVERY) throw bad(`The shortest interval is ${MIN_EVERY} minutes.`);
      if (minutes > MAX_EVERY) throw bad('The longest interval is 7 days (168 hours).');
      const anchor = Number(r.anchor);
      return { kind: 'every', minutes, anchor: Number.isFinite(anchor) && anchor > 0 ? anchor : now };
    }
    case 'daily':
    case 'weekdays': {
      const time = parseTime(r.time);
      if (!time) throw bad('Give the time as HH:MM, 24-hour (for example 09:00 or 17:30).');
      return { kind: r.kind, time };
    }
    default:
      throw bad('Choose when it runs: once, every N minutes or hours, daily, or on weekdays.');
  }
}

const isWeekday = (d) => d.getDay() >= 1 && d.getDay() <= 5;

/** The first time strictly after `after` (ms) that the recurrence is due, or null when there is none (a past "once"). */
export function nextOccurrence(rec, after) {
  switch (rec?.kind) {
    case 'once':
      return rec.at > after ? rec.at : null;
    case 'every': {
      const step = rec.minutes * 60_000;
      if (after < rec.anchor) return rec.anchor + step;
      return rec.anchor + (Math.floor((after - rec.anchor) / step) + 1) * step;
    }
    case 'daily':
    case 'weekdays': {
      const [hh, mm] = rec.time.split(':').map(Number);
      const d = new Date(after);
      d.setHours(hh, mm, 0, 0);
      // At most a week of days to look at (a weekend is two); setHours again each day keeps the local time across DST.
      for (let i = 0; i < 9; i++) {
        if (d.getTime() > after && (rec.kind === 'daily' || isWeekday(d))) return d.getTime();
        d.setDate(d.getDate() + 1);
        d.setHours(hh, mm, 0, 0);
      }
      return null;
    }
    default:
      return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
const localStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "Every 2 hours", "Weekdays at 09:00", "Once, 2026-11-21 14:00". */
export function describeRecurrence(rec) {
  switch (rec?.kind) {
    case 'once':
      return `Once, ${localStamp(rec.at)}`;
    case 'every':
      if (rec.minutes % 60 === 0) return rec.minutes === 60 ? 'Every hour' : `Every ${rec.minutes / 60} hours`;
      return `Every ${rec.minutes} minutes`;
    case 'daily':
      return `Daily at ${rec.time}`;
    case 'weekdays':
      return `Weekdays at ${rec.time}`;
    default:
      return 'Unknown';
  }
}

// ---- /schedule -------------------------------------------------------------------------------------------------------

export const SCHEDULE_USAGE = [
  'Usage: `/schedule <when> <task>`. The task runs as an unattended run in its own worktree; its changes wait for you in Review.',
  '',
  'When:',
  '- `daily 09:00`, `weekdays 18:30` (24-hour, this computer\'s time)',
  '- `every 30m`, `every 2h`, `every 45 minutes`, `hourly` (at least 5 minutes)',
  '- `once 14:00` (today, or tomorrow if that time has passed), `once 2026-12-01 09:00`, `in 20m`',
  '',
  'Options (anywhere): `--commands` lets it run commands in the worktree without asking (destructive ones are still denied); without it only file edits run and every other command is denied. `--direct` skips the plan step.',
  '',
  'Example: `/schedule daily 09:00 --commands run the tests and fix failures`',
  '`/schedule list` shows your schedules. Manage them in Runs (Ctrl+2).',
].join('\n');

const UNIT = /^(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i;
const toMinutes = (n, unit) => (/^h/i.test(unit) ? n * 60 : n);

/**
 * Read `/schedule` arguments: "daily 09:00 --commands run the tests". Returns { recurrence, task, mode, commands }, or
 * throws with what is wrong. `now` decides what "once 14:00" and "in 20m" mean.
 */
export function parseScheduleCommand(text, now = Date.now()) {
  let words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let commands = false;
  let mode = 'plan';
  words = words.filter((w) => {
    const f = w.toLowerCase();
    if (f === '--commands') return !(commands = true);
    if (f === '--direct') return !(mode = 'direct');
    if (f === '--plan') return !(mode = 'plan');
    return true;
  });
  const lower = (i) => String(words[i] || '').toLowerCase();
  let rec = null;
  let used = 0;
  const kw = lower(0);
  const at = lower(1) === 'at' ? 2 : 1; // "daily at 09:00" reads like "daily 09:00"
  if (kw === 'daily' || kw === 'weekdays') {
    const time = parseTime(words[at]);
    if (!time) throw bad(`After "${kw}", give a time as HH:MM (for example 09:00).\n\n${SCHEDULE_USAGE}`);
    rec = { kind: kw, time };
    used = at + 1;
  } else if (kw === 'hourly') {
    rec = { kind: 'every', minutes: 60, anchor: now };
    used = 1;
  } else if (kw === 'every' || kw === 'in') {
    let n;
    let unit;
    const glued = /^(\d+)([a-z]+)$/i.exec(words[1] || '');
    if (glued && UNIT.test(glued[2])) (n = Number(glued[1])), (unit = glued[2]), (used = 2);
    else if (/^\d+$/.test(words[1] || '') && UNIT.test(words[2] || '')) (n = Number(words[1])), (unit = words[2]), (used = 3);
    else throw bad(`After "${kw}", give a number and a unit (for example 30m or 2h).\n\n${SCHEDULE_USAGE}`);
    rec = kw === 'every' ? { kind: 'every', minutes: toMinutes(n, unit), anchor: now } : { kind: 'once', at: now + toMinutes(n, unit) * 60_000 };
  } else if (kw === 'once' || kw === 'at') {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(words[1] || '');
    if (date) {
      const time = parseTime(words[2]);
      if (!time) throw bad(`After the date, give a time as HH:MM.\n\n${SCHEDULE_USAGE}`);
      const [hh, mm] = time.split(':').map(Number);
      const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hh, mm, 0, 0);
      if (d.getMonth() !== Number(date[2]) - 1) throw bad('That date does not exist.');
      rec = { kind: 'once', at: d.getTime() };
      used = 3;
    } else {
      const time = parseTime(words[1]);
      if (!time) throw bad(`After "${kw}", give a time as HH:MM or a date and time (2026-12-01 09:00).\n\n${SCHEDULE_USAGE}`);
      const [hh, mm] = time.split(':').map(Number);
      const d = new Date(now);
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() <= now) (d.setDate(d.getDate() + 1), d.setHours(hh, mm, 0, 0));
      rec = { kind: 'once', at: d.getTime() };
      used = 2;
    }
  } else throw bad(SCHEDULE_USAGE);
  const task = words.slice(used).join(' ').trim();
  if (!task) throw bad(`Say what the run should do after the time.\n\n${SCHEDULE_USAGE}`);
  const recurrence = normalizeRecurrence(rec, now);
  if (recurrence.kind === 'once' && recurrence.at <= now) throw bad('That time has already passed.');
  return { recurrence, task, mode, commands };
}

// ---- Store -----------------------------------------------------------------------------------------------------------

export function newScheduleId() {
  return `s${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

/** The schedules, kept in one JSON file. */
export class ScheduleStore {
  constructor(file) {
    this.file = file;
    this.items = new Map();
    this.load();
  }

  load() {
    this.items.clear();
    const j = readJson(this.file, null);
    for (const s of Array.isArray(j?.schedules) ? j.schedules : []) {
      if (!s || !ID_RE.test(String(s.id)) || !s.project || !s.task) continue;
      try {
        s.recurrence = normalizeRecurrence(s.recurrence, s.createdAt);
      } catch {
        continue;
      }
      this.items.set(s.id, s);
    }
  }

  save() {
    writeJson(this.file, { version: 1, schedules: [...this.items.values()] });
  }

  get(id) {
    const s = this.items.get(String(id));
    if (!s) throw bad('That schedule does not exist', 404);
    return s;
  }

  has(id) {
    return this.items.has(String(id));
  }

  /** Oldest first, the order you made them in. */
  list() {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  put(s) {
    this.items.set(s.id, s);
    this.save();
    return s;
  }

  remove(id) {
    this.get(id);
    this.items.delete(String(id));
    this.save();
  }
}

// ---- Scheduler -------------------------------------------------------------------------------------------------------

/**
 * Decides when schedules start runs. Everything outside it is injected, so it can be tested without a clock or runs:
 *   now()              the time (ms)
 *   startRun(s, info)  start an unattended run for schedule `s`; resolves to the run ({ id }). info: { missed }
 *   runStatus(id)      a run's status, or null when the run no longer exists
 *   checkProject(dir)  optional: throws when the folder cannot hold a run (not a Git repository)
 *   onChange(s|{id, removed})
 */
export class Scheduler {
  constructor({ store, now = () => Date.now(), startRun, runStatus = () => null, checkProject = async () => {}, onChange = () => {}, setInterval: si = setInterval, clearInterval: ci = clearInterval }) {
    Object.assign(this, { store, now, startRun, runStatus, checkProject, onChange, si, ci });
    this.starting = new Set(); // schedule ids whose run is being started right now
    this.timer = null;
    this.ticking = null;
  }

  /** Start checking: the first check runs at once, which is the start-up catch-up. */
  start(ms = TICK_MS) {
    if (this.timer) return this.ticking;
    this.timer = this.si(() => this.tick().catch((e) => log('schedule tick failed', e)), ms);
    this.timer?.unref?.();
    return this.tick().catch((e) => log('schedule tick failed', e));
  }

  stop() {
    if (this.timer) this.ci(this.timer);
    this.timer = null;
  }

  /** True while the schedule's last run is still working (or being started). */
  busy(s) {
    if (this.starting.has(s.id)) return true;
    const st = s.lastRunId ? this.runStatus(s.lastRunId) : null;
    return !!st && WORKING.has(st);
  }

  view(s) {
    const st = s.lastRunId ? this.runStatus(s.lastRunId) : null;
    return { ...s, describe: describeRecurrence(s.recurrence), running: this.busy(s), lastRunStatus: st || (s.lastRunId ? 'removed' : '') };
  }

  list() {
    return this.store.list().map((s) => this.view(s));
  }

  _note(s, entry) {
    s.history = [{ at: this.now(), ...entry }, ...(s.history || [])].slice(0, HISTORY);
  }

  _changed(s) {
    s.updatedAt = this.now();
    this.store.put(s);
    try {
      this.onChange(this.view(s));
    } catch (e) {
      log('schedule notify failed', e);
    }
  }

  async create({ project, task, recurrence, mode = 'plan', commands = false, model = '', enabled = true, title = '' }) {
    const text = String(task || '').trim();
    if (!text) throw bad('Describe the task first.');
    if (text.length > MAX_TASK) throw bad(`The task is too long (the limit is ${MAX_TASK} characters).`);
    if (!project || typeof project !== 'string') throw bad('Choose a project first.');
    const now = this.now();
    const rec = normalizeRecurrence(recurrence, now);
    const nextAt = nextOccurrence(rec, now);
    if (nextAt == null) throw bad('That time has already passed.');
    await this.checkProject(project);
    const s = {
      id: newScheduleId(),
      version: 1,
      project,
      task: text,
      title: clip(String(title || '').trim() || text.split('\n')[0], 80),
      recurrence: rec,
      mode: mode === 'direct' ? 'direct' : 'plan',
      scope: { edits: true, commands: !!commands },
      model: String(model || ''),
      enabled: enabled !== false,
      nextAt: enabled !== false ? nextAt : null,
      lastAt: null,
      lastRunId: '',
      lastError: '',
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this._changed(s);
    return this.view(s);
  }

  /** Switch on or off. Switching on counts from now: times missed while it was off are not run. */
  setEnabled(id, on) {
    const s = this.store.get(id);
    if (on) {
      const next = nextOccurrence(s.recurrence, this.now());
      if (next == null) throw bad('Its time has passed. Make a new schedule, or press Run now.', 409);
      s.enabled = true;
      s.nextAt = next;
    } else {
      s.enabled = false;
      s.nextAt = null;
    }
    this._changed(s);
    return this.view(s);
  }

  remove(id) {
    this.store.remove(id);
    this.onChange({ id: String(id), removed: true });
  }

  /** Start the schedule's run now, outside its times. Refused while its last run is still working. */
  async runNow(id) {
    const s = this.store.get(id);
    if (this.busy(s)) throw bad('Its last run is still working. Wait for it, or stop it in Runs.', 409);
    return this._start(s, { manual: true });
  }

  async _start(s, { missed = false, manual = false, due = null } = {}) {
    this.starting.add(s.id);
    try {
      const run = await this.startRun(s, { missed });
      s.lastAt = this.now();
      s.lastRunId = run?.id || '';
      s.lastError = '';
      this._note(s, { run: s.lastRunId, ...(due != null ? { due } : {}), ...(missed ? { missed: true } : {}), ...(manual ? { manual: true } : {}) });
      return run;
    } catch (e) {
      s.lastAt = this.now();
      s.lastError = clip(e?.message || String(e), 400);
      this._note(s, { error: s.lastError, ...(due != null ? { due } : {}) });
      if (manual) throw e;
      log('scheduled run did not start', s.id, e);
      return null;
    } finally {
      this.starting.delete(s.id);
      if (this.store.has(s.id)) this._changed(s);
    }
  }

  /**
   * Start every schedule that is due. Each due schedule starts at most one run, however many of its times passed
   * (after a start-up, that is the catch-up), and its next time is counted from now. A schedule whose last run is still
   * working skips this time.
   */
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const now = this.now();
      const started = [];
      for (const s of this.store.list()) {
        if (!s.enabled || s.nextAt == null || s.nextAt > now) continue;
        const due = s.nextAt;
        // "Missed": more than one check late, which means ORBIX was closed (or asleep) when it was due.
        const missed = now - due > 2 * TICK_MS;
        s.nextAt = nextOccurrence(s.recurrence, now);
        if (s.recurrence.kind === 'once') s.enabled = false;
        if (this.busy(s)) {
          this._note(s, { skipped: 'the last run was still working', due });
          this._changed(s);
          continue;
        }
        this._changed(s); // the next time is saved before the run starts, so a crash cannot start it twice
        started.push(this._start(s, { missed, due }));
      }
      return (await Promise.all(started)).filter(Boolean);
    })();
    try {
      return await this.ticking;
    } finally {
      this.ticking = null;
    }
  }
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------

/** The HTTP API of schedules. */
export function scheduleRoutes(s) {
  const S = () => s.schedules;
  return {
    'GET /api/schedules': async () => ({ schedules: S().list() }),
    'POST /api/schedules/create': async ({ body }) => ({
      schedule: await S().create({ project: body.project, task: body.task, recurrence: body.recurrence, mode: body.mode, commands: body.commands === true, model: body.model, enabled: body.enabled !== false }),
    }),
    'POST /api/schedule/enable': async ({ body }) => ({ schedule: S().setEnabled(body.id, body.enabled === true) }),
    'POST /api/schedule/run': async ({ body }) => {
      const run = await S().runNow(body.id);
      return { run, schedule: S().view(S().store.get(body.id)) };
    },
    'POST /api/schedule/delete': async ({ body }) => (S().remove(body.id), {}),
  };
}
