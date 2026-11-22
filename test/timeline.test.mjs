// The conversation timeline: one dot per message at the transcript's left edge. The DOM side runs in the e2e suite
// (e2e/conversation.mjs); these check the text helpers and the rules the strip must keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NARROW, firstLine, dotLabel } from '../web/js/timeline-text.mjs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const block = () => {
  const css = read('css/shell.css');
  const start = css.indexOf('/* ================= conversation timeline');
  assert.ok(start >= 0, 'the timeline styles are missing from shell.css');
  return css.slice(start, css.indexOf('/* =================', start + 10));
};

test('a dot shows the first non-empty line, flattened and cut to length', () => {
  assert.equal(firstLine('\n   Fix the   login bug \nand add a test'), 'Fix the login bug');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(null), '');
  const long = firstLine('x'.repeat(200), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('every dot has a spoken label: who, where, and what', () => {
  assert.equal(dotLabel(true, 1, 4, 'Fix it'), 'Your message 1 of 4: Fix it');
  assert.equal(dotLabel(false, 2, 4, ''), 'Reply 2 of 4');
});

test('the strip hides below 520px and never works on scroll', () => {
  assert.equal(NARROW, 520);
  const js = read('js/timeline.js');
  assert.match(js, /new IntersectionObserver\(/, 'lit dots come from an IntersectionObserver');
  assert.doesNotMatch(js, /addEventListener\('scroll'/, 'nothing listens to scroll');
  assert.match(js, /aria-label/, 'dots are labelled');
  assert.match(js, /prefers-reduced-motion/, 'the jump respects reduced motion');
});

test('the styles animate only transform and opacity, use theme tokens, and stop for reduced motion', () => {
  const css = block();
  for (const [, list] of css.matchAll(/transition:\s*([^;]+);/g)) {
    if (list.trim() === 'none') continue;
    for (const part of list.split(',')) assert.match(part.trim(), /^(transform|opacity)\b/, `animates more than transform and opacity: ${part}`);
  }
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'a literal colour instead of a theme token');
  for (const t of ['--fg-3', '--line-2', '--live']) assert.ok(css.includes(`var(${t})`), `${t} is not used`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*transition: none/, 'no reduced-motion rule');
});
