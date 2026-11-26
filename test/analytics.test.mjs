// Settings → Analytics: one session file's sums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSession } from '../src/analytics.mjs';

const line = (o) => JSON.stringify(o);
const at = (h, m = 0) => new Date(2026, 10, 20, h, m).getTime(); // a Friday

test('tokens by day and model, your messages by hour, and agent time per turn', () => {
  const text = [
    line({ type: 'session', id: 's1' }),
    line({ type: 'message', message: { role: 'user', timestamp: at(9) } }),
    line({ type: 'message', message: { role: 'assistant', model: 'm1', provider: 'p', timestamp: at(9, 1), doneAt: at(9, 2), usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5 } } }),
    line({ type: 'message', message: { role: 'user', timestamp: at(14) } }),
    line({ type: 'message', message: { role: 'assistant', id: 'a2', model: 'm2', provider: 'q', timestamp: at(14, 1), doneAt: at(14, 11) } }),
    line({ type: 'usage', id: 'a2', usage: { input: 10, output: 5 } }),
    '{"torn',
  ].join('\n');
  const s = summarizeSession(text);
  const d = s.days['2026-11-20'];
  assert.deepEqual({ ...d }, { input: 110, output: 25, cacheRead: 50, cacheWrite: 5, prompts: 2, workMs: 2 * 60000 + 11 * 60000 });
  assert.equal(s.models['p/m1'].tokens, 175);
  assert.equal(s.models['q/m2'].tokens, 15);
  assert.equal(s.hours['2026-11-20'][9], 1);
  assert.equal(s.hours['2026-11-20'][14], 1);
});

test('streaks: the run ending today (or yesterday) and the longest run', async () => {
  const { streaks } = await import('../src/analytics.mjs');
  const today = new Date(2026, 10, 26);
  assert.deepEqual(streaks(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-24', '2026-11-25', '2026-11-26'], today), { current: 3, longest: 3 });
  assert.deepEqual(streaks(['2026-11-24', '2026-11-25'], today), { current: 2, longest: 2 }, 'yesterday still counts');
  assert.deepEqual(streaks(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'], today), { current: 0, longest: 4 });
  assert.deepEqual(streaks([], today), { current: 0, longest: 0 });
});

test('a session file remembers its project folder', () => {
  const s = summarizeSession([JSON.stringify({ type: 'session', id: 's', cwd: 'C:\\work\\shop' }), JSON.stringify({ type: 'message', message: { role: 'user', timestamp: Date.now() } })].join('\n'));
  assert.equal(s.cwd, 'C:\\work\\shop');
});
