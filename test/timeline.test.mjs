// The conversation timeline: one dot per message at the transcript's left edge. The DOM side runs in the e2e suite
// (e2e/conversation.mjs); these check the text helpers and the rules the strip must keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MIN_WINDOW, TIP_CHARS, firstLine, dotLabel } from '../web/js/timeline-text.mjs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const block = () => {
  const css = read('css/transcript.css');
  const start = css.indexOf('/* ================= conversation timeline');
  assert.ok(start >= 0, 'the timeline styles are missing from transcript.css');
  const end = css.indexOf('/* =================', start + 10);
  return end < 0 ? css.slice(start) : css.slice(start, end);
};

test('a dot shows the first non-empty line, flattened and cut to length', () => {
  assert.equal(firstLine('\n   Fix the   login bug \nand add a test'), 'Fix the login bug');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(null), '');
  const long = firstLine('x'.repeat(200), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('every dot has a spoken label: which of your messages, and what it says', () => {
  assert.equal(dotLabel(1, 4, 'Fix it'), 'Your message 1 of 4: Fix it');
  assert.equal(dotLabel(2, 4, ''), 'Your message 2 of 4');
});

test('the strip hides under 1100px, shows 60 characters, has one dot per turn and never works on scroll', () => {
  assert.equal(MIN_WINDOW, 1100);
  assert.equal(TIP_CHARS, 60);
  const js = read('js/timeline.js');
  assert.match(js, /new IntersectionObserver\(/, 'lit dots come from an IntersectionObserver');
  assert.doesNotMatch(js, /addEventListener\('scroll'/, 'nothing listens to scroll');
  assert.match(js, /aria-label/, 'dots are labelled');
  assert.match(js, /querySelectorAll\(':scope > \.msg\.user, :scope > \.msg\.asst:not\(\.live\)'\)/, 'replies are watched so their turn counts as on screen');
  assert.match(js, /const users = \[\]/, 'the dots are your messages only');
  assert.match(js, /prefers-reduced-motion/, 'the jump respects reduced motion');
});

test('the styles animate only transform and opacity, use theme tokens, and stop for reduced motion', () => {
  const css = block();
  for (const [, list] of css.matchAll(/transition:\s*([^;]+);/g)) {
    if (list.trim() === 'none') continue;
    for (const part of list.split(',')) assert.match(part.trim(), /^(transform|opacity)\b/, `animates more than transform and opacity: ${part}`);
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'a literal colour instead of a theme token');
  for (const t of ['--fg-3', '--line-2', '--accent-solid']) assert.ok(css.includes(`var(${t})`), `${t} is not used`);
  assert.match(css, /@media \(max-width: 1099px\)/, 'no rule hides the strip under 1100px');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*transition: none/, 'no reduced-motion rule');
});
