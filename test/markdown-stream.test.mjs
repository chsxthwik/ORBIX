import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownBoundary, liveExcerpt, LIVE_MARKDOWN_LIMIT } from '../web/js/markdown-stream.mjs';

test('stream preview respects incomplete blocks, fences, indentation and cursor reset', () => {
  const scan = new MarkdownBoundary();
  let s = 'First\n\n';
  assert.equal(scan.advance(s), 0);
  s += '```text\npartial\n\n';
  assert.equal(scan.advance(s), 'First\n\n'.length);
  s += '~~\n```\n\n';
  assert.equal(scan.advance(s), 'First\n\n'.length);
  const before = s.length;
  s += 'Next\n\n    indented continuation\n';
  assert.equal(scan.advance(s), before);
  s += '\nDone.';
  assert.equal(scan.advance(s), s.indexOf('Done.'));
  scan.reset();
  assert.equal(scan.advance('Revised'), 0);
});

test('stream preview is bounded and does not split a surrogate pair at its start', () => {
  assert.equal(liveExcerpt('Short text.'), 'Short text.');
  const text = '🙂'.repeat(10_000) + '!';
  const excerpt = liveExcerpt(text);
  assert.ok(excerpt.length <= LIVE_MARKDOWN_LIMIT + 2);
  assert.match(excerpt, /^…\n🙂/u);
  assert.ok(excerpt.endsWith('!'));
});
