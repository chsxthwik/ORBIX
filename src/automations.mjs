// Loops (stored as automations): a prompt that ORBIX sends by itself on a schedule (every few minutes, every hour,
// every day, on weekdays, every week, or once at a set time), in a project, as a new conversation. They run while ORBIX is open; a time missed while it was closed is skipped,
// not caught up. Each run is an ordinary conversation, so approvals work as usual: in Supervised it waits for you in
// Review. Stored in data/automations.json.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { readJson, writeJson, uid, clip } from './util.mjs';

const EVERY = ['minutes', 'hour', 'day', 'weekday', 'week', 'once'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TICK_MS = 30000;

/** Is `s` a schedule ORBIX understands? Returns a clean copy, or throws with what is wrong. */
export function cleanSchedule(s = {}) {
  const every = EVERY.includes(s.every) ? s.every : null;
  if (!every) throw Object.assign(new Error('Choose how often it runs'), { status: 400 });
  if (every === 'minutes') {
    const n = Number(s.interval);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw Object.assign(new Error('Run it every 5 to 1440 minutes'), { status: 400 });
    return { every, interval: n };
  }
  if (every === 'once') {
    const at = Number(s.at);
    if (!Number.isFinite(at) || at <= 0) throw Object.assign(new Error('Choose the date and time it runs'), { status: 400 });
    return { every, at: Math.floor(at / 60000) * 60000 };
  }
  const minute = Number.isInteger(s.minute) && s.minute >= 0 && s.minute < 60 ? s.minute : 0;
  if (every === 'hour') return { every, minute };
  const hour = Number.isInteger(s.hour) && s.hour >= 0 && s.hour < 24 ? s.hour : 9;
  if (every === 'week') return { every, hour, minute, day: Number.isInteger(s.day) && s.day >= 0 && s.day < 7 ? s.day : 1 };
  return { every, hour, minute };
}

/** The first time strictly after `after` (ms) that the schedule fires, in local time. */
export function nextRun(schedule, after) {
  const s = cleanSchedule(schedule);
  if (s.every === 'minutes') return Math.floor(after / 60000) * 60000 + s.interval * 60000;
  if (s.every === 'once') return s.at > after ? s.at : null;
  const d = new Date(after);
  d.setSeconds(0, 0);
  if (s.every === 'hour') {
    d.setMinutes(s.minute);
    if (d.getTime() <= after) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  d.setHours(s.hour, s.minute, 0, 0);
  const ok = (x) => (s.every === 'weekday' ? x.getDay() >= 1 && x.getDay() <= 5 : s.every === 'week' ? x.getDay() === s.day : true);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > after && ok(d)) return d.getTime();
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** "Every day at 09:00", "Weekdays at 18:30", "Every Monday at 09:00", "Every hour at :15". */
export function describeSchedule(schedule) {
  const s = cleanSchedule(schedule);
  if (s.every === 'minutes') return s.interval % 60 === 0 ? `Every ${s.interval / 60 === 1 ? 'hour' : `${s.interval / 60} hours`}` : `Every ${s.interval} minutes`;
  if (s.every === 'once') {
    const d = new Date(s.at);
    return `Once, ${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const hm = `${String(s.hour ?? 0).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
  if (s.every === 'hour') return `Every hour at :${String(s.minute).padStart(2, '0')}`;
  if (s.every === 'day') return `Every day at ${hm}`;
  if (s.every === 'weekday') return `Weekdays at ${hm}`;
  return `Every ${DAYS[s.day]} at ${hm}`;
}

export class Automations {
  /** server: start(automation) runs one (opens a conversation in its project and sends the prompt), returns a proc id. */
  constructor({ start, alive, dir = DATA_DIR, now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'automations.json');
    this.start = start;
    this.alive = alive || (() => false);
    this.now = now;
    this.list = (readJson(this.file, []) || []).filter((a) => a && a.id && a.prompt);
    // Times missed while ORBIX was closed are skipped: each enabled automation waits for its next time from now.
    for (const a of this.list) {
      a.nextAt = a.enabled ? nextRun(a.schedule, this.now()) : null;
      if (a.enabled && a.schedule?.every === 'once' && !a.nextAt) a.enabled = false; // its time passed while ORBIX was closed
    }
    this.timer = null;
  }

  begin() {
    this.timer ||= setInterval(() => this.tick().catch(() => {}), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJson(this.file, this.list.map(({ nextAt, ...a }) => a));
  }

  view() {
    return this.list.map((a) => ({ ...a, when: describeSchedule(a.schedule), nextAt: a.enabled ? a.nextAt : null, running: !!(a.lastProc && this.alive(a.lastProc)) }));
  }

  /** Create (no id) or change one. */
  upsert(input = {}) {
    const name = clip(String(input.name || '').trim(), 80);
    const prompt = String(input.prompt || '').trim();
    const project = String(input.project || '').trim();
    if (!prompt) throw Object.assign(new Error('Write what it should do'), { status: 400 });
    if (prompt.length > 8000) throw Object.assign(new Error('Keep the task under 8,000 characters'), { status: 400 });
    if (!project) throw Object.assign(new Error('Choose a project'), { status: 400 });
    const schedule = cleanSchedule(input.schedule);
    if (schedule.every === 'once' && input.enabled !== false && schedule.at <= this.now()) throw Object.assign(new Error('Choose a time in the future'), { status: 400 });
    const model = typeof input.model === 'string' && /^[\w.-]+\/.+/.test(input.model) ? input.model : '';
    let a = input.id ? this.list.find((x) => x.id === input.id) : null;
    if (input.id && !a) throw Object.assign(new Error('That loop no longer exists'), { status: 404 });
    if (!a) {
      a = { id: uid('au'), createdAt: this.now(), lastRun: null, lastStatus: '', lastProc: '' };
      this.list.push(a);
    }
    Object.assign(a, { name: name || clip(prompt.split('\n')[0], 60), prompt, project, schedule, model, enabled: input.enabled !== false });
    a.nextAt = a.enabled ? nextRun(a.schedule, this.now()) : null;
    this.save();
    return a;
  }

  remove(id) {
    const n = this.list.length;
    this.list = this.list.filter((a) => a.id !== id);
    if (this.list.length !== n) this.save();
    return n - this.list.length;
  }

  /** Run one now (Run now, or its time came). A run still working is not started twice. */
  async run(id, why = 'manual') {
    const a = this.list.find((x) => x.id === id);
    if (!a) throw Object.assign(new Error('That loop no longer exists'), { status: 404 });
    if (a.lastProc && this.alive(a.lastProc)) {
      if (why === 'manual') throw Object.assign(new Error('Its last run is still working'), { status: 409 });
      return null;
    }
    a.lastRun = this.now();
    try {
      a.lastProc = await this.start(a);
      a.lastStatus = 'started';
    } catch (e) {
      a.lastProc = '';
      a.lastStatus = `failed: ${clip(String(e.message || e), 200)}`;
    }
    this.save();
    return a;
  }

  /** Every half minute: start what is due, then move each started one to its next time. */
  async tick() {
    const t = this.now();
    for (const a of [...this.list]) {
      if (!a.enabled || !a.nextAt || t < a.nextAt) continue;
      a.nextAt = nextRun(a.schedule, t);
      if (a.schedule.every === 'once') {
        a.enabled = false; // done: it stays in the list, off, with its last run
        a.nextAt = null;
      }
      await this.run(a.id, 'schedule');
    }
  }
}
