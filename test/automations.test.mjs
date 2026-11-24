import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Automations, nextRun, describeSchedule, cleanSchedule } from '../src/automations.mjs';
import { rmTmp } from './fixtures/tmp.mjs';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

describe('automation schedules', () => {
  test('every hour fires at its minute, after the given time', () => {
    assert.equal(nextRun({ every: 'hour', minute: 15 }, at(2026, 11, 20, 10, 0)), at(2026, 11, 20, 10, 15));
    assert.equal(nextRun({ every: 'hour', minute: 15 }, at(2026, 11, 20, 10, 15)), at(2026, 11, 20, 11, 15));
  });
  test('every day, weekdays and a weekly day', () => {
    assert.equal(nextRun({ every: 'day', hour: 9, minute: 0 }, at(2026, 11, 20, 10, 0)), at(2026, 11, 21, 9, 0));
    // Nov 20, 2026 is a Friday: the next weekday 09:00 after Friday 10:00 is Monday.
    assert.equal(nextRun({ every: 'weekday', hour: 9, minute: 0 }, at(2026, 11, 20, 10, 0)), at(2026, 11, 23, 9, 0));
    assert.equal(nextRun({ every: 'week', day: 3, hour: 18, minute: 30 }, at(2026, 11, 20, 10, 0)), at(2026, 11, 25, 18, 30));
  });
  test('schedules are checked and described plainly', () => {
    assert.throws(() => cleanSchedule({ every: 'minute' }), /how often/);
    assert.equal(describeSchedule({ every: 'weekday', hour: 18, minute: 5 }), 'Weekdays at 18:05');
    assert.equal(describeSchedule({ every: 'week', day: 1, hour: 9, minute: 0 }), 'Every Monday at 09:00');
  });
});

describe('the automation list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-auto-'));
  let clock = at(2026, 11, 20, 8, 59);
  const started = [];
  const busy = new Set();
  const make = () => new Automations({ dir, now: () => clock, start: async (a) => (started.push(a.id), `p${started.length}`), alive: (id) => busy.has(id) });

  test('creates, saves and reloads; a due one starts once and waits for its next time', async () => {
    const list = make();
    const a = list.upsert({ prompt: 'Run the tests and report failures', project: 'C:\\shop', schedule: { every: 'day', hour: 9, minute: 0 } });
    assert.equal(a.name, 'Run the tests and report failures');
    assert.equal(a.nextAt, at(2026, 11, 20, 9, 0));
    clock = at(2026, 11, 20, 9, 0, 10);
    await list.tick();
    assert.deepEqual(started, [a.id]);
    assert.equal(list.view()[0].nextAt, at(2026, 11, 21, 9, 0));
    await list.tick();
    assert.equal(started.length, 1, 'not twice for one time');
    const again = make();
    assert.equal(again.view().length, 1, 'kept on disk');
    assert.equal(again.view()[0].lastStatus, 'started');
  });
  test('Run now refuses while the last run still works; a missing prompt is refused', async () => {
    const list = make();
    const a = list.view()[0];
    busy.add(a.lastProc);
    await assert.rejects(list.run(a.id), /still working/);
    busy.clear();
    await list.run(a.id);
    assert.equal(started.length, 2);
    assert.throws(() => list.upsert({ prompt: '', project: 'C:\\x', schedule: { every: 'day' } }), /what it should do/);
    assert.equal(list.remove(a.id), 1);
    assert.equal(make().view().length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('loops: every N minutes and once', async () => {
  const { cleanSchedule, nextRun, describeSchedule } = await import('../src/automations.mjs');
  const t0 = new Date(2026, 10, 21, 10, 0, 30).getTime();
  assert.equal(nextRun({ every: 'minutes', interval: 15 }, t0), new Date(2026, 10, 21, 10, 15).getTime());
  assert.equal(describeSchedule({ every: 'minutes', interval: 15 }), 'Every 15 minutes');
  assert.equal(describeSchedule({ every: 'minutes', interval: 120 }), 'Every 2 hours');
  assert.throws(() => cleanSchedule({ every: 'minutes', interval: 2 }), /5 to 1440/);
  const at = new Date(2026, 10, 21, 12, 0).getTime();
  assert.equal(nextRun({ every: 'once', at }, t0), at);
  assert.equal(nextRun({ every: 'once', at }, at + 1), null);
  assert.match(describeSchedule({ every: 'once', at }), /^Once, .* at 12:00$/);
});

test('a pending start cannot launch twice and a failed start is recorded', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-auto-start-'));
  t.after(() => rmTmp(dir));
  let fail;
  const loops = new Automations({ dir, start: () => new Promise((_resolve, reject) => { fail = reject; }) });
  const a = loops.upsert({ prompt: 'List project tasks', project: 'C:\\shop', schedule: { every: 'day' } });
  const pending = loops.run(a.id);
  assert.equal(loops.view()[0].starting, true);
  await assert.rejects(loops.run(a.id), /still working/);
  fail(new Error('No model connected'));
  assert.equal((await pending).lastStatus, 'failed: No model connected');
  assert.equal(loops.view()[0].starting, false);
  assert.equal(new Automations({ dir }).view()[0].lastStatus, 'failed: No model connected');
});
