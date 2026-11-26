// The line splitter behind MCP servers, agent CLIs (Claude Code, Codex, ACP) and ripgrep: lines in any chunking,
// early stop, a runaway line dropped, and time linear in the input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineSplitter } from '../src/linesplit.mjs';

const collect = (chunks, opts) => {
  const lines = [];
  const s = lineSplitter((l) => void lines.push(l), opts);
  for (const c of chunks) s.push(c);
  return { lines, rest: s.rest() };
};

test('lines come out whole however the text is cut into chunks', () => {
  const text = '{"a":1}\n{"b":2}\r\n\nlast line\nno newline at the end';
  for (let size = 1; size <= text.length; size++) {
    const chunks = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const { lines, rest } = collect(chunks);
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}\r', '', 'last line'], `chunks of ${size}`);
    assert.equal(rest, 'no newline at the end', `chunks of ${size}`);
  }
});

test('returning false stops the splitter, and later chunks are ignored', () => {
  const seen = [];
  const s = lineSplitter((l) => (seen.push(l), l !== 'stop'));
  assert.equal(s.push('a\nstop\nb\n'), false);
  assert.equal(s.push('c\n'), false);
  assert.deepEqual(seen, ['a', 'stop']);
});

test('a line longer than maxLine is reported once and dropped up to its newline', () => {
  let over = 0;
  const { lines } = collect(['ok\n', 'x'.repeat(40), 'x'.repeat(40), 'tail of the long line\nafter\n'], { maxLine: 50, onOverflow: () => over++ });
  assert.equal(over, 1);
  assert.deepEqual(lines, ['ok', 'after'], 'nothing of the long line comes out, the next line does');
});

test('one 32 MB line in 64 KB chunks is split in linear time', () => {
  const chunk = 'x'.repeat(64 * 1024);
  let got = 0;
  const s = lineSplitter((l) => (got = l.length));
  const t0 = performance.now();
  for (let i = 0; i < 512; i++) s.push(chunk);
  s.push('\n');
  const ms = performance.now() - t0;
  assert.equal(got, 32 * 1024 * 1024);
  // Searching the whole growing buffer on every chunk took ~4 s for this; one scan per chunk takes tens of ms.
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
