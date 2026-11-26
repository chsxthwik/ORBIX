// Usage across every saved conversation, for Settings → Analytics: tokens by day and kind, the models used, when you
// prompt (day of week × hour), and how long agents worked. Read from the session files on this PC; each file's sums
// are cached by size and change time, so a refresh only reads what changed.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';
import { pool } from './util.mjs';

const cache = new Map(); // file -> { mtime, size, days, models, heat }
const DAY = 86400000;
const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const blankDay = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompts: 0, workMs: 0 });

/** One session file's sums: per day (with your messages by hour, local time) and per model. */
export function summarizeSession(text) {
  const messages = [];
  const usageOf = new Map();
  let cwd = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session' && typeof o.cwd === 'string') cwd = o.cwd;
    else if (o.type === 'message' && o.message) messages.push(o.message);
    else if (o.type === 'usage' && o.id && o.usage) usageOf.set(o.id, o.usage); // an agent CLI's turn total
  }
  const days = {};
  const models = {};
  const hours = {}; // day -> 24 counts of your messages
  const day = (ms) => (days[dayKey(ms)] ||= blankDay());
  let turnStart = 0;
  let turnEnd = 0;
  const closeTurn = () => {
    if (turnStart && turnEnd > turnStart) day(turnStart).workMs += Math.min(turnEnd - turnStart, 6 * 3600000); // a stuck turn counts 6 h at most
    turnStart = turnEnd = 0;
  };
  for (const m of messages) {
    const at = m.timestamp || 0;
    if (!at) continue;
    if (m.role === 'user') {
      closeTurn();
      turnStart = at;
      day(at).prompts++;
      (hours[dayKey(at)] ||= new Array(24).fill(0))[new Date(at).getHours()]++;
    } else if (m.role === 'assistant') {
      const u = (m.id && usageOf.get(m.id)) || m.usage;
      if (u) {
        const b = day(at);
        for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) b[k] += Number(u[k]) || 0;
        const name = typeof m.model === 'string' && m.model ? m.model : '';
        if (name) {
          const x = (models[`${m.provider || ''}/${name}`] ||= { model: name, provider: m.provider || '', tokens: 0, replies: 0, last: 0 });
          x.tokens += (Number(u.input) || 0) + (Number(u.output) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0);
          x.replies++;
          x.last = Math.max(x.last, at);
        }
      }
      turnEnd = Math.max(turnEnd, m.doneAt || at);
    }
  }
  closeTurn();
  return { days, models, hours, cwd };
}

async function sessionFiles() {
  const root = path.join(DATA_DIR, 'sessions');
  let dirs;
  try {
    dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const lists = await pool(dirs, 8, async (d) => (await fs.promises.readdir(path.join(root, d.name)).catch(() => [])).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(root, d.name, n)));
  return lists.flatMap((x) => x || []);
}

/** Every session file's sums (cached by size and change time), and the list of files. */
async function loadSums() {
  const files = await sessionFiles();
  const sums = await pool(files, 8, async (file) => {
    try {
      const st = await fs.promises.stat(file);
      const hit = cache.get(file);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
      const s = { mtime: st.mtimeMs, size: st.size, ...summarizeSession(await fs.promises.readFile(file, 'utf8')) };
      cache.set(file, s);
      return s;
    } catch {
      return null;
    }
  });
  const live = new Set(files);
  for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return { files, sums };
}

/** Totals for the last `range` days (7, 30 or 90), ending today. */
export async function analytics(range = 30) {
  const span = [7, 30, 90].includes(Number(range)) ? Number(range) : 30;
  const { files, sums } = await loadSums();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const keys = Array.from({ length: span }, (_, i) => dayKey(today.getTime() - (span - 1 - i) * DAY));
  const inRange = new Set(keys);
  const days = Object.fromEntries(keys.map((k) => [k, blankDay()]));
  const models = {};
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const from = today.getTime() - (span - 1) * DAY;
  for (const s of sums) {
    if (!s) continue;
    for (const [k, d] of Object.entries(s.days)) if (inRange.has(k)) for (const f of Object.keys(d)) days[k][f] += d[f];
    for (const [k, m] of Object.entries(s.models)) {
      if (m.last < from) continue;
      const x = (models[k] ||= { model: m.model, provider: m.provider, tokens: 0, replies: 0 });
      x.tokens += m.tokens;
      x.replies += m.replies;
    }
  }
  // Your messages in the range by weekday and hour (local time).
  for (const s of sums) {
    if (!s) continue;
    for (const [k, row] of Object.entries(s.hours)) {
      if (!inRange.has(k)) continue;
      const [y, mo, d] = k.split('-').map(Number);
      const wd = new Date(y, mo - 1, d).getDay();
      for (let h = 0; h < 24; h++) heat[wd][h] += row[h];
    }
  }

  const list = keys.map((k) => ({ date: k, ...days[k] }));
  let streak = 0;
  for (let i = list.length - 1; i >= 0 && list[i].prompts > 0; i--) streak++;
  const busiest = list.reduce((a, d) => (d.prompts > (a?.prompts || 0) ? d : a), null);
  return {
    range: span,
    days: list,
    models: Object.values(models).sort((a, b) => b.tokens - a.tokens).slice(0, 12),
    heat,
    streak,
    busiestDay: busiest?.prompts ? busiest.date : null,
    conversations: files.length,
  };
}

const tokensOf = (d) => d.input + d.output + d.cacheRead + d.cacheWrite;

/** Days in a row with at least one message of yours: the run ending today (or yesterday, if today has none yet) and the longest. */
export function streaks(activeKeys, today = new Date()) {
  const set = new Set(activeKeys);
  const t = new Date(today);
  t.setHours(0, 0, 0, 0);
  let cur = 0;
  let d = t.getTime();
  if (!set.has(dayKey(d))) d -= DAY;
  while (set.has(dayKey(d))) (cur++, (d -= DAY));
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of [...set].sort()) {
    const [y, m, dd] = k.split('-').map(Number);
    const ms = new Date(y, m - 1, dd).getTime();
    run = prev != null && Math.round((ms - prev) / DAY) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = ms;
  }
  return { current: cur, longest };
}

/**
 * Settings → Profile: everything since the first conversation on this PC. Lifetime tokens and messages, the busiest
 * day, streaks, a year of activity by day, and the provider, model, hour and project you use most.
 */
export async function profile() {
  const { files, sums } = await loadSums();
  const days = {};
  const models = {};
  const hours = new Array(24).fill(0);
  const projects = {};
  for (const s of sums) {
    if (!s) continue;
    let prompts = 0;
    for (const [k, d] of Object.entries(s.days)) {
      const x = (days[k] ||= blankDay());
      for (const f of Object.keys(d)) x[f] += d[f];
      prompts += d.prompts;
    }
    for (const [k, m] of Object.entries(s.models)) {
      const x = (models[k] ||= { model: m.model, provider: m.provider, tokens: 0, replies: 0 });
      x.tokens += m.tokens;
      x.replies += m.replies;
    }
    for (const row of Object.values(s.hours)) for (let i = 0; i < 24; i++) hours[i] += row[i];
    if (s.cwd && prompts) projects[s.cwd] = (projects[s.cwd] || 0) + prompts;
  }
  const keys = Object.keys(days).sort();
  const active = keys.filter((k) => days[k].prompts > 0);
  const peak = keys.reduce((a, k) => (tokensOf(days[k]) > (a ? tokensOf(days[a]) : 0) ? k : a), null);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // A year of days ending today, starting on a Sunday so the grid has whole weeks.
  const start = new Date(today.getTime() - 364 * DAY);
  start.setDate(start.getDate() - start.getDay());
  const year = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) { // by calendar day, so DST changes cannot skip one
    const k = dayKey(d.getTime());
    const x = days[k];
    year.push({ date: k, prompts: x?.prompts || 0, tokens: x ? tokensOf(x) : 0 });
  }
  const byProvider = {};
  for (const m of Object.values(models)) if (m.provider) byProvider[m.provider] = (byProvider[m.provider] || 0) + m.replies;
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0] || null;
  const replies = Object.values(models).reduce((n, m) => n + m.replies, 0);
  const hourMax = Math.max(...hours);
  const proj = top(projects);
  return {
    tokens: keys.reduce((n, k) => n + tokensOf(days[k]), 0),
    prompts: keys.reduce((n, k) => n + days[k].prompts, 0),
    workMs: keys.reduce((n, k) => n + days[k].workMs, 0),
    peakDay: peak && tokensOf(days[peak]) ? { date: peak, tokens: tokensOf(days[peak]) } : null,
    activeDays: active.length,
    firstDay: active[0] || null,
    streak: streaks(active, today),
    year,
    topProvider: top(byProvider)?.[0] || null,
    topHour: hourMax > 0 ? hours.indexOf(hourMax) : null,
    topProject: proj ? { path: proj[0], prompts: proj[1] } : null,
    models: Object.values(models).sort((a, b) => b.replies - a.replies).slice(0, 6).map((m) => ({ ...m, share: replies ? m.replies / replies : 0 })),
    conversations: files.length,
  };
}
