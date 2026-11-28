import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffRows, splitDiffRows } from '../web/js/diff-rows.mjs';

test('diff rows preserve code resembling Git headers and count both sides of each hunk', () => {
  const text = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -10,2 +10,3 @@', ' first', '---- old', '+++ new', '+last', '\\ No newline at end of file', '@@ -20 +21 @@', '-old', '+new', ''].join('\r\n');
  const rows = diffRows(text);
  assert.deepEqual(rows.filter((r) => r.a !== undefined).map(({ a, b, text, file }) => [a, b, text, file]), [
    [10, 10, 'first', 'a.js'],
    [11, '', '--- old', 'a.js'],
    ['', 11, '++ new', 'a.js'],
    ['', 12, 'last', 'a.js'],
    [20, '', 'old', 'a.js'],
    ['', 21, 'new', 'a.js'],
  ]);
  const split = splitDiffRows(rows);
  assert.equal(split[2].before, split[2].after);
  assert.equal(split[3].before.a, 11);
  assert.equal(split[3].after.b, 11);
  assert.equal(split[4].before, undefined);
  assert.equal(split[4].after.b, 12);
  assert.equal(split[5].meta.text, '\\ No newline at end of file');
});
