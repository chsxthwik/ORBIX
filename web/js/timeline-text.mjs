// Pure helpers for the conversation timeline (web/js/timeline.js), kept apart so tests can load them without a page.

/** Hidden when the transcript is narrower than this (px): the dots would sit on top of the text. */
export const NARROW = 520;

/** The first line of a message as plain text, at most `max` characters. */
export function firstLine(text, max = 80) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

/** The dot's spoken label: who wrote it, its place, and its first line. */
export function dotLabel(you, n, total, line) {
  return `${you ? 'Your message' : 'Reply'} ${n} of ${total}${line ? `: ${line}` : ''}`;
}
