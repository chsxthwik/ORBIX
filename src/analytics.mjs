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
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'message' && o.message) messages.push(o.message);
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
  return { days, models, hours };
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

/** Totals for the last `range` days (7, 30 or 90), ending today. */
export async function analytics(range = 30) {
  const span = [7, 30, 90].includes(Number(range)) ? Number(range) : 30;
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
