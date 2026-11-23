// Long conversations stay fast: the seed script for profiling (tools/seed-conversation.mjs, used by tools/perf.mjs),
// and the rules that keep a 2,000-message transcript cheap to open, scroll and stream into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedConversation } from '../tools/seed-conversation.mjs';

const read = (f) => fs.readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');

test('the seed script writes a conversation ORBIX can open, with exactly the messages asked for', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-seed-'));
  try {
    const { file, messages } = seedConversation({ data, cwd: path.join(data, 'project'), messages: 500 });
    assert.equal(messages, 500);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'session');
    const msgs = lines.filter((l) => l.type === 'message').map((l) => l.message);
    assert.equal(msgs.length, 500);
    const roles = new Set(msgs.map((m) => m.role));
    for (const r of ['user', 'assistant', 'toolResult']) assert.ok(roles.has(r), `no ${r} messages`);
    // Every tool result answers a call made before it.
    const calls = new Set(msgs.flatMap((m) => (m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall').map((c) => c.id) : [])));
    for (const m of msgs.filter((x) => x.role === 'toolResult')) assert.ok(calls.has(m.toolCallId), `an orphan result ${m.toolCallId}`);
    // Deterministic: the same arguments write the same file.
    const again = seedConversation({ data, cwd: path.join(data, 'project'), messages: 500 });
    assert.equal(fs.readFileSync(again.file, 'utf8'), fs.readFileSync(file, 'utf8'));
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a long transcript opens newest first, keeps every message in the page, and skips work off screen', () => {
  const s = read('js/session.js');
  assert.match(s, /fillEarlier\(/, 'older messages are not drawn in the background');
  assert.match(s, /finishFill/, 'Find cannot finish drawing the earlier messages');
  assert.match(read('js/workbench.js'), /finishFill\?\.\(\)/, 'Find does not wait for every message to be drawn');
  assert.match(read('css/app.css'), /\.tin > \.msg \{ content-visibility: auto; contain-intrinsic-size: auto/, 'off-screen messages are laid out');
});

test('drawing a reply does no work proportional to the whole conversation', () => {
  const s = read('js/session.js');
  // One search per reply over every message made opening quadratic.
  assert.match(s, /replyMeta\(m, idx\)/, 'replyMeta searches the messages for each reply');
  // Setting `hidden` on every reply's Retry button restyled all of them on each message.
  assert.doesNotMatch(s, /querySelectorAll\('\.retry'\)\.forEach/, 'every Retry button is touched on each message');
  // A new Intl formatter per message cost milliseconds each.
  assert.doesNotMatch(s, /toLocaleTimeString|toLocaleDateString|new Date\(ts\)\.toLocaleString\(\)/, 'a formatter is built per message');
  const tl = read('js/timeline.js');
  assert.doesNotMatch(tl, /clientWidth|offsetTop|scrollHeight/, 'the timeline reads layout');
});
