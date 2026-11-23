// Pure helpers for the conversation timeline (web/js/timeline.js), kept apart so tests can load them without a page.

/** Hidden in a window narrower than this (px). */
export const MIN_WINDOW = 1100;
/** How much of a message a dot shows on hover. */
export const TIP_CHARS = 60;

/** The first line of a message as plain text, at most `max` characters. */
export function firstLine(text, max = 80) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** The dot's spoken label: which of your messages it is, and its first line. */
export function dotLabel(n, total, line) {
  return `Your message ${n} of ${total}${line ? `: ${line}` : ''}`;
}
