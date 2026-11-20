// Schedules: recurrence math (local time, day/month/year rollover, weekends), the /schedule grammar, persistence,
// the scheduler with an injected clock (due, no overlapping runs, catch-up once after a restart, one-off schedules),
// and unattended runs end to end against a scripted model and a real git repository: anything that would ask is
// denied and written to the run's log, and the plan is approved with the schedule's scope.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-schedule-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
process.env.ORBIX_NO_RG = '1';
process.env.GIT_CEILING_DIRECTORIES = TMP;
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'tester';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });
const rec = { contextWindow: 200000, maxOutput: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: false };
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: { anthropic: { 'claude-test': rec } } }));

const realFetch = globalThis.fetch;
let script = [];
const requests = [];
globalThis.fetch = async (url, init) => {
  if (/mock\.anthropic/.test(String(url))) {
    requests.push(JSON.parse(init.body));
    const next = script.shift();
    if (!next) throw new Error('no scripted reply left');
    return new Response(next, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error('network is blocked in tests');
};

const { normalizeRecurrence, nextOccurrence, describeRecurrence, parseScheduleCommand, parseTime, ScheduleStore, Scheduler, TICK_MS } = await import('../src/schedule.mjs');
const { unattendedReason, UNATTENDED_DENIAL } = await import('../src/engine/policy.mjs');
const { scheduleCommand } = await import('../src/engine/slash.mjs');
const { RunController } = await import('../src/runctl.mjs');
const { AgentProc } = await import('../src/engine/proc.mjs');
const { PRESETS } = await import('../src/engine/providers.mjs');
const { Backend } = await import('../src/backend.mjs');
const { trackOpenUi } = await import('../src/server.mjs');
const gitapi = await import('../src/gitapi.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const MIN = 60_000;

// =====================================================================================================================
describe('recurrence math (local time)', () => {
  test('daily: later today, or tomorrow once the time has passed; months and years roll over', () => {
    const r = normalizeRecurrence({ kind: 'daily', time: '9:00' });
    assert.deepEqual(r, { kind: 'daily', time: '09:00' });
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 8, 59)), local(2026, 11, 20, 9, 0));
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 9, 0)), local(2026, 11, 21, 9, 0), 'strictly after: the same minute is the next day');
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 23, 30)), local(2026, 11, 21, 9, 0));
    assert.equal(nextOccurrence(r, local(2026, 11, 30, 10)), local(2026, 12, 1, 9, 0), 'end of month');
    assert.equal(nextOccurrence(r, local(2026, 12, 31, 22)), local(2027, 1, 1, 9, 0), 'end of year');
    assert.equal(nextOccurrence({ kind: 'daily', time: '00:00' }, local(2028, 2, 28, 1)), local(2028, 2, 29, 0, 0), 'leap day');
  });

  test('weekdays: Monday to Friday only, a Friday evening goes to Monday', () => {
    const r = { kind: 'weekdays', time: '18:30' };
    // 2026-11-20 is a Friday.
    assert.equal(new Date(local(2026, 11, 20)).getDay(), 5);
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 12)), local(2026, 11, 20, 18, 30));
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 19)), local(2026, 11, 23, 18, 30), 'Friday after the time -> Monday');
    assert.equal(nextOccurrence(r, local(2026, 11, 21, 8)), local(2026, 11, 23, 18, 30), 'Saturday -> Monday');
    assert.equal(nextOccurrence(r, local(2026, 11, 23, 19)), local(2026, 11, 24, 18, 30), 'Monday after the time -> Tuesday');
  });

  test('every N minutes counts from its anchor, never drifts, and skips times already passed', () => {
    const anchor = local(2026, 11, 20, 10, 7);
    const r = normalizeRecurrence({ kind: 'every', minutes: 90, anchor });
    assert.equal(nextOccurrence(r, anchor), anchor + 90 * MIN);
    assert.equal(nextOccurrence(r, anchor - 5 * MIN), anchor + 90 * MIN);
    assert.equal(nextOccurrence(r, anchor + 90 * MIN), anchor + 180 * MIN);
    assert.equal(nextOccurrence(r, anchor + 1000 * MIN), anchor + 1080 * MIN, 'the next slot after a long gap, not each missed one');
    assert.equal(nextOccurrence(r, local(2026, 11, 20, 23, 50)), local(2026, 11, 21, 1, 7), 'across midnight (10:07 + 10 × 90 min)');
  });

  test('once: due until its time, then never again', () => {
    const at = local(2026, 11, 21, 14);
    assert.equal(nextOccurrence({ kind: 'once', at }, at - 1), at);
    assert.equal(nextOccurrence({ kind: 'once', at }, at), null);
  });

  test('bad recurrences are refused with the reason; descriptions read plainly', () => {
    assert.throws(() => normalizeRecurrence({ kind: 'every', minutes: 1 }), /shortest interval is 5 minutes/);
    assert.throws(() => normalizeRecurrence({ kind: 'every', minutes: 60 * 24 * 8 }), /longest interval/);
    assert.throws(() => normalizeRecurrence({ kind: 'daily', time: '25:00' }), /HH:MM/);
    assert.throws(() => normalizeRecurrence({ kind: 'cron' }), /Choose when it runs/);
    assert.equal(parseTime('7:5'), null);
    assert.equal(describeRecurrence({ kind: 'every', minutes: 120 }), 'Every 2 hours');
    assert.equal(describeRecurrence({ kind: 'every', minutes: 60 }), 'Every hour');
    assert.equal(describeRecurrence({ kind: 'every', minutes: 45 }), 'Every 45 minutes');
    assert.equal(describeRecurrence({ kind: 'weekdays', time: '09:00' }), 'Weekdays at 09:00');
    assert.equal(describeRecurrence({ kind: 'once', at: local(2026, 12, 1, 9, 5) }), 'Once, 2026-12-01 09:05');
  });
});

// =====================================================================================================================
describe('/schedule grammar', () => {
  const now = local(2026, 11, 20, 15, 0);
  test('the documented example, and "at"', () => {
    const p = parseScheduleCommand('daily 09:00 run the tests and fix failures', now);
    assert.deepEqual(p, { recurrence: { kind: 'daily', time: '09:00' }, task: 'run the tests and fix failures', mode: 'plan', commands: false });
    assert.equal(parseScheduleCommand('weekdays at 8:15 tidy up', now).recurrence.time, '08:15');
  });
  test('intervals, one-off times (rolling to tomorrow), dates, and options anywhere', () => {
    assert.deepEqual(parseScheduleCommand('every 2h --commands check the build', now), { recurrence: { kind: 'every', minutes: 120, anchor: now }, task: 'check the build', mode: 'plan', commands: true });
    assert.equal(parseScheduleCommand('every 45 minutes x', now).recurrence.minutes, 45);
    assert.equal(parseScheduleCommand('hourly x', now).recurrence.minutes, 60);
    assert.equal(parseScheduleCommand('once 16:30 x', now).recurrence.at, local(2026, 11, 20, 16, 30));
    assert.equal(parseScheduleCommand('once 14:00 x', now).recurrence.at, local(2026, 11, 21, 14, 0), 'a time already passed today is tomorrow');
    assert.equal(parseScheduleCommand('once 2026-12-01 09:00 x', now).recurrence.at, local(2026, 12, 1, 9, 0));
    assert.equal(parseScheduleCommand('in 20m x', now).recurrence.at, now + 20 * MIN);
    const p = parseScheduleCommand('daily 07:00 fix lint --direct --commands', now);
    assert.equal(p.task, 'fix lint');
    assert.equal(p.mode, 'direct');
    assert.equal(p.commands, true);
  });
  test('mistakes are explained', () => {
    assert.throws(() => parseScheduleCommand('', now), /Usage/);
    assert.throws(() => parseScheduleCommand('daily nine run', now), /HH:MM/);
    assert.throws(() => parseScheduleCommand('daily 09:00', now), /what the run should do/);
    assert.throws(() => parseScheduleCommand('every 2 parsecs x', now), /number and a unit/);
    assert.throws(() => parseScheduleCommand('every 1m x', now), /5 minutes/);
    assert.throws(() => parseScheduleCommand('once 2025-01-01 09:00 x', now), /already passed/);
    assert.throws(() => parseScheduleCommand('once 2026-02-30 09:00 x', now), /does not exist/);
  });
});

// =====================================================================================================================
describe('scheduler (injected clock)', () => {
  let t;
  let n = 0;
  const statuses = new Map(); // run id -> status
  const started = [];
  const make = (file, extra = {}) =>
    new Scheduler({
      store: new ScheduleStore(file),
      now: () => t,
      startRun: async (s, info) => {
        const id = `run${++n}`;
        statuses.set(id, 'executing');
        started.push({ id, schedule: s.id, ...info });
        return { id };
      },
      runStatus: (id) => statuses.get(id) ?? null,
      setInterval: () => ({}),
      clearInterval: () => {},
      ...extra,
    });

  test('persistence: a schedule survives a reload exactly; broken entries are skipped', async () => {
    t = local(2026, 11, 20, 8, 0);
    const file = path.join(TMP, 'persist', 'schedules.json');
    const a = make(file);
    const s = await a.create({ project: 'C:\\repo ñ', task: 'Run the tests\nand fix failures', recurrence: { kind: 'weekdays', time: '09:00' }, commands: true, model: 'anthropic/claude-test' });
    assert.equal(s.title, 'Run the tests');
    assert.equal(s.nextAt, local(2026, 11, 20, 9, 0));
    assert.deepEqual(s.scope, { edits: true, commands: true });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.schedules.push({ id: '../x', project: 'p', task: 't' }, { id: 'sabcdefgh', project: 'p', task: 't', recurrence: { kind: 'daily', time: 'noon' } });
    fs.writeFileSync(file, JSON.stringify(raw));
    const b = make(file);
    assert.deepEqual(b.store.list(), [a.store.get(s.id)]);
    assert.equal(b.list()[0].describe, 'Weekdays at 09:00');
    await assert.rejects(b.create({ project: 'p', task: ' ', recurrence: { kind: 'daily', time: '09:00' } }), /Describe the task/);
    await assert.rejects(b.create({ project: 'p', task: 'x', recurrence: { kind: 'once', at: t - 1 } }), /already passed/);
    const refused = make(file, { checkProject: async () => { throw new Error('not a git repository'); } });
    await assert.rejects(refused.create({ project: 'p', task: 'x', recurrence: { kind: 'daily', time: '09:00' } }), /not a git repository/);
    assert.equal(make(file).store.list().length, 1, 'a refused schedule is not saved');
  });

  test('due: starts one run and moves to the next time; not due: nothing', async () => {
    t = local(2026, 11, 20, 8, 0);
    const sc = make(path.join(TMP, 'due.json'));
    const s = await sc.create({ project: 'p', task: 'x', recurrence: { kind: 'daily', time: '09:00' } });
    assert.equal((await sc.tick()).length, 0);
    t = local(2026, 11, 20, 9, 0, 0) + 5000;
    const runs = await sc.tick();
    assert.equal(runs.length, 1);
    const after = sc.store.get(s.id);
    assert.equal(after.lastRunId, runs[0].id);
    assert.equal(after.nextAt, local(2026, 11, 21, 9, 0), 'day rollover');
    assert.equal(started.at(-1).missed, false);
    assert.equal(after.history[0].run, runs[0].id);
  });

  test('no overlapping runs: a time that comes while the last run works is skipped, then it runs again', async () => {
    t = local(2026, 11, 20, 10, 0);
    const sc = make(path.join(TMP, 'overlap.json'));
    const s = await sc.create({ project: 'p', task: 'x', recurrence: { kind: 'every', minutes: 30 } });
    t += 30 * MIN;
    const [first] = await sc.tick();
    assert.ok(first);
    assert.equal(sc.view(sc.store.get(s.id)).running, true);
    t += 30 * MIN; // the run is still working
    assert.equal((await sc.tick()).length, 0);
    const v = sc.store.get(s.id);
    assert.match(v.history[0].skipped, /still working/);
    assert.equal(v.lastRunId, first.id);
    assert.equal(v.nextAt, t + 30 * MIN);
    await assert.rejects(sc.runNow(s.id), /still working/);
    statuses.set(first.id, 'review'); // it finished and waits for you: no longer working
    t += 30 * MIN;
    const [second] = await sc.tick();
    assert.ok(second && second.id !== first.id);
  });

  test('a run being started counts as working: two checks at once start one run', async () => {
    t = local(2026, 11, 20, 10, 0);
    let release;
    const gate = new Promise((r) => (release = r));
    let calls = 0;
    const sc = make(path.join(TMP, 'race.json'), {
      startRun: async () => {
        calls++;
        await gate;
        return { id: `slow${calls}` };
      },
    });
    const s = await sc.create({ project: 'p', task: 'x', recurrence: { kind: 'every', minutes: 5 } });
    t += 5 * MIN;
    const a = sc.tick();
    const b = sc.tick(); // the same check, not a second one
    await assert.rejects(sc.runNow(s.id), /still working/);
    release();
    await Promise.all([a, b]);
    assert.equal(calls, 1);
  });

  test('catch-up after a restart: an overdue schedule runs once, then continues from now', async () => {
    t = local(2026, 11, 16, 8, 0);
    const file = path.join(TMP, 'catchup.json');
    const s = await make(file).create({ project: 'p', task: 'x', recurrence: { kind: 'daily', time: '09:00' } });
    const off = await make(file).create({ project: 'p', task: 'y', recurrence: { kind: 'daily', time: '09:00' }, enabled: false });
    // ORBIX was closed for four days (four 09:00s missed) and starts again on Friday at 12:00.
    t = local(2026, 11, 20, 12, 0);
    const before = started.length;
    const sc = make(file);
    await sc.start();
    const mine = started.slice(before);
    assert.equal(mine.length, 1, 'once, not once per missed day');
    assert.equal(mine[0].schedule, s.id);
    assert.equal(mine[0].missed, true);
    assert.equal(sc.store.get(s.id).nextAt, local(2026, 11, 21, 9, 0));
    assert.equal(sc.store.get(s.id).history[0].missed, true);
    assert.equal(sc.store.get(off.id).lastRunId, '', 'a schedule that is off does not catch up');
    statuses.set(mine[0].id, 'review');
    assert.equal((await sc.tick()).length, 0, 'the next check does not run it again');
  });

  test('once: runs one time and turns itself off; it cannot be turned on again after its time', async () => {
    t = local(2026, 11, 20, 10, 0);
    const sc = make(path.join(TMP, 'once.json'));
    const s = await sc.create({ project: 'p', task: 'x', recurrence: { kind: 'once', at: t + 10 * MIN } });
    t += 11 * MIN;
    assert.equal((await sc.tick()).length, 1);
    const v = sc.store.get(s.id);
    assert.equal(v.enabled, false);
    assert.equal(v.nextAt, null);
    assert.throws(() => sc.setEnabled(s.id, true), /time has passed/);
  });

  test('turning off and on counts from now; a start that fails is recorded, not retried in a loop', async () => {
    t = local(2026, 11, 20, 10, 0);
    let fail = true;
    const sc = make(path.join(TMP, 'toggle.json'), { startRun: async () => (fail ? Promise.reject(new Error('worktree failed')) : { id: 'okrun' }) });
    const s = await sc.create({ project: 'p', task: 'x', recurrence: { kind: 'every', minutes: 60 } });
    sc.setEnabled(s.id, false);
    t += 5 * 60 * MIN;
    assert.equal((await sc.tick()).length, 0);
    sc.setEnabled(s.id, true);
    assert.equal(sc.store.get(s.id).nextAt, local(2026, 11, 20, 16, 0));
    t = local(2026, 11, 20, 16, 0);
    assert.equal((await sc.tick()).length, 0);
    assert.equal(sc.store.get(s.id).lastError, 'worktree failed');
    assert.equal(sc.store.get(s.id).nextAt, local(2026, 11, 20, 17, 0));
    await assert.rejects(sc.runNow(s.id), /worktree failed/);
    fail = false;
    assert.equal((await sc.runNow(s.id)).id, 'okrun');
    assert.equal(sc.store.get(s.id).lastError, '');
    sc.remove(s.id);
    assert.equal(sc.list().length, 0);
  });

  test('TICK_MS is short enough for a 5-minute interval', () => assert.ok(TICK_MS <= 60_000));
});

// =====================================================================================================================
describe('unattended policy', () => {
  test('anything that would ask is denied, with the reason; the schedule scope runs', () => {
    const scope = { edits: true, commands: false };
    assert.equal(unattendedReason({ name: 'read', scope }), '');
    assert.equal(unattendedReason({ name: 'edit', needsApproval: true, scope }), '');
    assert.match(unattendedReason({ name: 'bash', command: 'npm test', needsApproval: true, scope }), /does not allow commands/);
    assert.equal(unattendedReason({ name: 'bash', command: 'npm test', needsApproval: true, scope, trusted: true }), '', 'a command you trust');
    assert.equal(unattendedReason({ name: 'bash', command: 'npm test', needsApproval: true, scope: { edits: true, commands: true } }), '');
    assert.match(unattendedReason({ name: 'bash', command: 'git push origin main', needsApproval: true, scope: { edits: true, commands: true }, trusted: true }), /pushes to a remote/, 'destructive is denied whatever the scope');
    assert.match(unattendedReason({ name: 'read', outside: true, scope }), /outside the run's worktree/);
    assert.match(unattendedReason({ name: 'write', needsApproval: true, scope: {} }), /does not allow file edits/);
    assert.match(unattendedReason({ name: 'mcp_db_write', needsApproval: true, scope }), /does not allow mcp_db_write/);
    assert.match(UNATTENDED_DENIAL, /Do not retry/);
  });
});

// =====================================================================================================================
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function turn({ text = '', tools = [] }) {
  const out = [ev('message_start', { message: { id: 'm', usage: { input_tokens: 10, output_tokens: 0 } } })];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }), ev('content_block_stop', { index: i }));
    i++;
  }
  for (const t of tools) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: t.id, name: t.name } }), ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.args) } }), ev('content_block_stop', { index: i }));
    i++;
  }
  out.push(ev('message_delta', { delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }), ev('message_stop', {}));
  return out.join('');
}
const g = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const until = async (fn, what = 'condition', ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('unattended runs started by a schedule (scripted model, real git)', () => {
  const backend = new Backend({ kind: 'native' });
  // "Turbo" (approvals: auto) on purpose: an unattended run must not be widened by the global approval mode.
  const config = {
    data: { approvals: 'auto', providers: {}, defaultModel: 'anthropic/claude-test', trusted: [], verify: 'off', review: false },
    provider: (pid) => PRESETS.find((p) => p.id === pid),
    type: (pid) => PRESETS.find((p) => p.id === pid)?.type,
    baseUrl: () => 'http://mock.anthropic',
    configured: (pid) => pid === 'anthropic',
    configuredIds: () => ['anthropic'],
    getKey: async () => 'test-key',
    addTrusted: () => {},
  };
  let repo;
  let seq = 0;
  let server;
  let ctl;
  let sched;
  let clock = Date.now();

  function fakeServer() {
    const s = {
      backend,
      procs: new Map(),
      sent: [],
      broadcast: (m) => s.sent.push(m),
      broadcastProcs: () => {},
      async startProc({ workspace, resume, model, branch, worktree: given }) {
        let worktree = given && !resume ? given : null;
        if (branch && !resume && !worktree) {
          const wt = await gitapi.worktreeAdd(backend, workspace);
          worktree = { repo: wt.repo, slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base, baseBranch: wt.baseBranch, source: workspace };
          workspace = wt.workspace;
        }
        const id = `p${++seq}`;
        const proc = new AgentProc({ id, backend, workspace, resume, model, config, worktree });
        proc.openUi = new Map();
        proc.on('event', (e) => trackOpenUi(proc.openUi, e));
        proc.on('exit', () => s.procs.delete(id));
        await proc.start();
        s.procs.set(id, proc);
        s.runs?.adopt(proc);
        return proc;
      },
    };
    return s;
  }
  const status = (id) => ctl.store.get(id).status;
  const waitFor = (id, st) => until(() => status(id) === st, `run to be ${st} (it is ${status(id)})`);
  const types = (id) => ctl.store.events(id).map((e) => e.type);

  before(() => {
    repo = path.join(TMP, 'sched repo ñ');
    fs.mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q');
    g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    put(repo, 'src/sum.js', 'export const sum = (a, b) => a - b;\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'start');
    server = fakeServer();
    ctl = server.runs = new RunController(server, path.join(DATA, 'runs'));
    sched = new Scheduler({
      store: new ScheduleStore(path.join(DATA, 'schedules.json')),
      now: () => clock,
      startRun: (s, { missed }) => ctl.start({ workspace: s.project, task: s.task, mode: s.mode, model: s.model || undefined, unattended: { scheduleId: s.id, commands: s.scope.commands, missed } }),
      runStatus: (id) => (ctl.store.has(id) ? ctl.store.get(id).status : null),
      setInterval: () => ({}),
      clearInterval: () => {},
    });
  });
  after(async () => {
    for (const p of server.procs.values()) await p.stop(500);
  });

  test('straight to work, edits only: a command is denied without asking, logged, and the run still ends in review', async () => {
    const s = await sched.create({ project: repo, task: 'sum() subtracts. Make it add.', recurrence: { kind: 'every', minutes: 60 }, mode: 'direct', commands: false });
    script = [
      turn({ tools: [{ id: 'e1', name: 'edit', args: { path: 'src/sum.js', old_string: 'a - b', new_string: 'a + b' } }] }),
      turn({ tools: [{ id: 'b1', name: 'bash', args: { command: 'node -e "console.log(1)"' } }] }),
      turn({ tools: [{ id: 'r1', name: 'read', args: { path: path.join(TMP, 'persist', 'schedules.json') } }] }), // outside the worktree
      turn({ text: 'Done.' }),
    ];
    clock += 61 * MIN;
    const [run] = await sched.tick();
    assert.ok(run, 'the schedule started a run');
    assert.equal(run.unattended.scheduleId, s.id);
    await waitFor(run.id, 'review');
    const r = ctl.store.get(run.id);
    assert.equal(read(r.workspace, 'src/sum.js'), 'export const sum = (a, b) => a + b;\n', 'the edit inside the scope ran');
    assert.equal(read(repo, 'src/sum.js'), 'export const sum = (a, b) => a - b;\n', 'your checkout is untouched');
    const log = ctl.store.events(run.id);
    const denied = log.filter((e) => e.type === 'policy.denied');
    assert.deepEqual(denied.map((e) => e.tool), ['bash', 'read']);
    assert.match(denied[0].reason, /does not allow commands/);
    assert.match(denied[0].title, /node -e/);
    assert.match(denied[1].reason, /outside the run's worktree/);
    assert.ok(!types(run.id).includes('approval.requested'), 'nothing asked');
    assert.equal(log.find((e) => e.type === 'tool.result' && e.call === 'b1').ok, false);
    assert.equal(ctl.live.get(run.id).openUi.size, 0);
    // The model was told why, and that it was unattended.
    assert.match(JSON.stringify(requests.at(-1).messages), /unattended scheduled run/);
    assert.ok(requests.some((q) => /nobody is watching it/.test(JSON.stringify(q.messages))), 'the task says it is unattended');
    assert.ok(types(run.id).includes('schedule.started'));
    const granted = log.find((e) => e.type === 'scope.granted');
    assert.equal(granted.by, 'schedule');
    assert.equal(granted.commands, false);
    assert.equal(sched.view(sched.store.get(s.id)).running, false);
    sched.setEnabled(s.id, false);
  });

  test('plan first: the plan is approved with the schedule scope; a destructive command is still denied; feedback ends unattended', async () => {
    const s = await sched.create({ project: repo, task: 'Add a README line.', recurrence: { kind: 'daily', time: '09:00' }, mode: 'plan', commands: true });
    script = [
      turn({ tools: [{ id: 'p1', name: 'artifact', args: { kind: 'plan', content: '# Plan\n1. Add a line to README.md\n2. Push it' } }] }),
      turn({ text: 'The plan is ready.' }),
      turn({ tools: [{ id: 'w1', name: 'write', args: { path: 'README.md', content: '# demo\nhello\n' } }] }),
      turn({ tools: [{ id: 'b2', name: 'bash', args: { command: 'git push origin main' } }] }),
      turn({ tools: [{ id: 'b3', name: 'bash', args: { command: 'node -e "process.exit(0)"' } }] }),
      turn({ text: 'Done; the push was denied.' }),
    ];
    const run = await sched.runNow(s.id);
    await waitFor(run.id, 'review');
    const r = ctl.store.get(run.id);
    const log = ctl.store.events(run.id);
    const approved = log.find((e) => e.type === 'plan.approved');
    assert.equal(approved.by, 'schedule');
    assert.deepEqual(approved.scope, { edits: true, commands: true });
    assert.equal(read(r.workspace, 'README.md'), '# demo\nhello\n');
    const denied = log.filter((e) => e.type === 'policy.denied');
    assert.equal(denied.length, 1);
    assert.match(denied[0].reason, /pushes to a remote/);
    assert.equal(log.find((e) => e.type === 'tool.result' && e.call === 'b3').ok, true, 'an ordinary command in scope ran');
    assert.ok(!types(run.id).includes('approval.requested'));
    assert.equal(r.unattended.active, true);
    assert.equal(sched.store.get(s.id).history[0].manual, true);
    // You act on it yourself: from now on it asks you like any other run.
    script = [turn({ tools: [{ id: 'b4', name: 'bash', args: { command: 'git push origin main' } }] }), turn({ text: 'ok' })];
    await ctl.feedback(run.id, 'Try the push again.');
    const proc = ctl.live.get(run.id);
    await until(() => proc.openUi.size > 0, 'an approval question now that you are there');
    assert.equal(ctl.store.get(run.id).unattended.active, false);
    assert.ok(types(run.id).includes('unattended.ended'));
    const ask = [...proc.openUi.values()][0];
    proc.send({ type: 'extension_ui_response', id: ask.id, value: 'Deny' });
    proc.openUi.delete(ask.id);
    await waitFor(run.id, 'review');
  });

  test('/schedule makes a schedule for the conversation\'s project, and lists them', async () => {
    const agent = { schedules: sched, workspace: '/wt/x', worktree: { source: repo }, provider: 'anthropic', model: 'claude-test' };
    const out = await scheduleCommand(agent, 'weekdays 07:30 --commands run the tests and fix failures');
    assert.match(out, /Scheduled \*\*run the tests and fix failures\*\*: Weekdays at 07:30/);
    assert.match(out, /denied and shown in the run's log/);
    const made = sched.store.list().at(-1);
    assert.equal(made.project, repo);
    assert.equal(made.model, 'anthropic/claude-test');
    assert.equal(made.scope.commands, true);
    assert.match(await scheduleCommand(agent, 'list'), /Weekdays at 07:30/);
    assert.match(await scheduleCommand(agent, 'daily x'), /HH:MM/);
    assert.match(await scheduleCommand({ workspace: repo }, 'daily 09:00 x'), /need the ORBIX app/);
  });
});
