// A provider that stops sending mid-reply must not hang the turn: the reader gives up after the quiet limit with a
// retryable "connection lost" error, and a stream that keeps sending is read to the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE, streamError } from '../src/engine/anthropic.mjs';

const enc = new TextEncoder();
function body(chunks, { hang = false } = {}) {
  return new ReadableStream({
    async start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      if (!hang) c.close();
    },
  });
}

test('a silent stream ends with a retryable connection error', async () => {
  const got = [];
  await assert.rejects(async () => {
    try {
      for await (const ev of parseSSE(body(['data: {"a":1}\n\n'], { hang: true }), null, 60)) got.push(ev.data);
    } catch (e) {
      throw streamError(e, null);
    }
  }, (e) => e.retryable === true && /no data from the provider for 0 seconds|Connection lost/.test(e.message));
  assert.deepEqual(got, ['{"a":1}']);
});

test('a stream that keeps sending is read to the end', async () => {
  const got = [];
  for await (const ev of parseSSE(body(['data: 1\n\n', 'data: 2\n\n', 'data: 3']), null, 60)) got.push(ev.data);
  assert.deepEqual(got, ['1', '2', '3']);
});
