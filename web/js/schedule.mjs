// Loops → Create with Prompt: "Every weekday at 9am, run the tests and tell me what fails" becomes a schedule
// (weekdays, 09:00) and a task ("Run the tests and tell me what fails"). Plain rules, no model: what it finds is
// shown in the form for you to check before anything is saved.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?s?';
const dayIndex = (w) => DAYS.findIndex((d) => d.startsWith(w.toLowerCase().slice(0, 3)));

/** "9", "9am", "9:30 pm", "18:00", "noon", "midnight" → [hour, minute], or null. */
function parseTime(text) {
  const t = text.toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(t)) return { hm: [12, 0], re: /\b(at\s+)?(noon|midday)\b/i };
  if (/\bmidnight\b/.test(t)) return { hm: [0, 0], re: /\b(at\s+)?midnight\b/i };
  const m = /\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=[\s,.;!?]|$)/i.exec(text);
  if (m && (m[2] || m[3] || /\bat\s+\d/i.test(m[0]))) {
    let hour = Number(m[1]);
    const minute = Number(m[2] || 0);
    const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (hour < 24 && minute < 60) return { hm: [hour, minute], re: new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  }
  if (/\b(every|each|in the)\s+morning\b/.test(t)) return { hm: [9, 0], re: null };
  if (/\b(every|each|in the)\s+evening\b/.test(t)) return { hm: [18, 0], re: null };
  if (/\b(every|each|at)\s+night\b/.test(t)) return { hm: [21, 0], re: null };
  return null;
}

/**
 * The schedule and the task in one sentence. Returns { schedule, prompt, found } where `found` is false when no
 * schedule words were found (the schedule is then the default: every day at 09:00).
 */
export function parseSchedule(input, now = Date.now()) {
  let text = String(input || '').trim();
  const cut = (re) => {
    if (re) text = text.replace(re, ' ');
  };
  const tidy = (t) => {
    let p = t.replace(/\s+/g, ' ').replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '').replace(/^(please\s+)?(to|and|then)\s+/i, '').trim();
    return p ? p[0].toUpperCase() + p.slice(1) : p;
  };
  // "every 15 minutes", "every 2 hours": an interval.
  let x = /\bevery\s+(\d{1,4})\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (x) {
    const n = Number(x[1]) * (/^h/i.test(x[2]) ? 60 : 1);
    if (n >= 5 && n <= 1440 && !(n % 60 === 0 && n / 60 === 1)) {
      cut(x[0]);
      return { schedule: { every: 'minutes', interval: n }, prompt: tidy(text), found: true };
    }
  }
  // "in 2 hours", "in 30 minutes": once, that long from now.
  x = /\bin\s+(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?)\b/i.exec(text);
  if (x) {
    const mult = /^d/i.test(x[2]) ? 1440 : /^h/i.test(x[2]) ? 60 : 1;
    cut(x[0]);
    return { schedule: { every: 'once', at: Math.ceil((now + Number(x[1]) * mult * 60000) / 60000) * 60000 }, prompt: tidy(text), found: true };
  }
  // "today at 5pm", "tomorrow at 9": once, at that time.
  x = /\b(today|tonight|tomorrow)\b/i.exec(text);
  if (x) {
    const t = parseTime(input);
    const d = new Date(now);
    if (/tomorrow/i.test(x[1])) d.setDate(d.getDate() + 1);
    const [hh, mm] = t ? t.hm : /tonight/i.test(x[1]) ? [21, 0] : [9, 0];
    d.setHours(hh, mm, 0, 0);
    cut(x[0]);
    if (t) cut(t.re);
    return { schedule: { every: 'once', at: d.getTime() }, prompt: tidy(text), found: true };
  }
  let every = null;
  let day;
  let m;
  if ((m = /\b(every\s+hour|hourly|each\s+hour)\b/i.exec(text))) every = 'hour';
  else if ((m = /\b(every\s+weekday|on\s+weekdays|weekdays|each\s+weekday|monday\s+(?:to|through|-)\s+friday|mon\s*-\s*fri)\b/i.exec(text))) every = 'weekday';
  else if ((m = new RegExp(`\\b(?:every|each|on)\\s+${DAY_RE}\\b`, 'i').exec(text))) {
    every = 'week';
    day = dayIndex(m[1]);
  } else if ((m = /\b(weekly|every\s+week|once\s+a\s+week)\b/i.exec(text))) {
    every = 'week';
    day = 1;
  } else if ((m = /\b(every\s+day|daily|each\s+day|every\s+(?:morning|evening|night)|each\s+(?:morning|evening))\b/i.exec(text))) every = 'day';
  const found = !!every;
  if (m) cut(m[0]);
  const time = parseTime(input);
  let hour = 9;
  let minute = 0;
  if (every === 'hour') {
    const mm = /\b(?:at\s+)?:(\d{2})\b|\bat\s+(\d{1,2})\s+(?:minutes?\s+)?past\b/i.exec(text);
    if (mm) {
      minute = Math.min(59, Number(mm[1] || mm[2]));
      cut(mm[0]);
    }
  } else if (time) {
    [hour, minute] = time.hm;
    cut(time.re);
  }
  cut(/\b(in the\s+)?(morning|evening|night)\b/i);
  const schedule = every === 'hour' ? { every, minute } : every === 'week' ? { every, hour, minute, day: day ?? 1 } : { every: every || 'day', hour, minute };
  let prompt = text.replace(/\s+/g, ' ').replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '').replace(/^(please\s+)?(to|and|then)\s+/i, '').trim();
  if (prompt) prompt = prompt[0].toUpperCase() + prompt.slice(1);
  return { schedule, prompt, found: found || !!time };
}
