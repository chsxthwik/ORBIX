import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff } from '../web/js/word-diff.mjs';

const words = (line, ranges) => ranges.map(([s, e]) => line.slice(s, e));

test('marks an inserted call as one change, not two around a repeated bracket', () => {
  const a = 'const user = findByEmail(email.trim());';
  const b = 'const user = findByEmail(email.trim().toLowerCase());';
  const [ra, rb] = wordDiff(a, b);
  assert.deepEqual(ra, []);
  assert.deepEqual(words(b, rb), ['.toLowerCase()']);
});

test('marks a replaced word on both sides', () => {
  const [ra, rb] = wordDiff('return a + b;', 'return a - b;');
  assert.deepEqual(words('return a + b;', ra), ['+']);
  assert.deepEqual(words('return a - b;', rb), ['-']);
});

test('joins changes split only by spaces', () => {
  const a = 'let total = price;';
  const b = 'let total = price * quantity * rate;';
  const [, rb] = wordDiff(a, b);
  assert.deepEqual(words(b, rb), ['* quantity * rate']);
});

test('no marks for a rewrite, identical lines, spacing alone or very long lines', () => {
  assert.equal(wordDiff('foo(bar)', 'totally different line here'), null);
  assert.equal(wordDiff('same', 'same'), null);
  assert.equal(wordDiff('if (x) return y;', 'if (x) return y; '), null);
  assert.equal(wordDiff('x'.repeat(1300), 'y'.repeat(1300)), null);
});
