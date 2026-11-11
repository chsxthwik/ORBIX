// Tests for the run-end checks: finding a project's check command, the check after edits (fail, fix, pass; ask;
// approval; not repeating the agent's own run), the one-pass review of the diff, and plain tool-step titles. The
// agent loop runs against a scripted Anthropic-compatible mock, as in agent.test.mjs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-checks-test-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
process.env.ORBIX_NO_RG = '1';
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });
const rec = { contextWindow: 200000, maxOutput: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null };
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: { anthropic: { 'claude-test': rec } } }));

const realFetch = globalThis.fetch;
const requests = [];
let script = [];
globalThis.fetch = async (url, init) => {
  if (/mock\.anthropic/.test(String(url))) {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    return next();
  }
  throw new Error('network is blocked in tests');
};

const { AgentProc } = await import('../src/engine/proc.mjs');
const { PRESETS } = await import('../src/engine/providers.mjs');
const { Backend } = await import('../src/backend.mjs');
const verify = await import('../src/engine/verify.mjs');
const { toolTitle } = await import('../web/js/tool-title.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function turn({ text = '', tools = [], stop = 'end_turn', input = 100, output = 20 }) {
  const out = [ev('message_start', { message: { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })];
  let i = 0;
  if (text) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }));
    out.push(ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }));
    out.push(ev('content_block_stop', { index: i }));
    i++;
  }
  for (const t of tools) {
    out.push(ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: t.id, name: t.name } }));
    out.push(ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.args) } }));
    out.push(ev('content_block_stop', { index: i }));
    i++;
  }
  out.push(ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: output } }));
  out.push(ev('message_stop', {}));
  return out.join('');
}
const reply = (o) => () => new Response(turn(o), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const userText = (body) => body.messages.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((c) => c.text || (typeof c.content === 'string' ? c.content : '')).join('\n');

// =====================================================================================================
describe('detectCheck finds the command that checks a project', () => {
  const dir = (name, files) => {
    const d = path.join(TMP, 'detect', name);
    for (const [f, c] of Object.entries(files)) put(path.join(d, f), c);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  test('package.json: test first, then typecheck, check, lint, build; the npm init placeholder is no test', () => {
    assert.deepEqual(verify.detectCheck(dir('npm', { 'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }) })), { command: 'npm test', source: 'package.json script "test"' });
    assert.equal(verify.detectCheck(dir('placeholder', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }) })).command, 'npm run lint');
    assert.equal(verify.detectCheck(dir('tc', { 'package.json': JSON.stringify({ scripts: { build: 'vite build', typecheck: 'tsc --noEmit' } }) })).command, 'npm run typecheck');
    assert.equal(verify.detectCheck(dir('noscripts', { 'package.json': '{}' })), null);
  });
  test('the lock file picks the package manager', () => {
    const scripts = JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } });
    assert.equal(verify.detectCheck(dir('pnpm', { 'package.json': scripts, 'pnpm-lock.yaml': '' })).command, 'pnpm test');
    assert.equal(verify.detectCheck(dir('yarn', { 'package.json': JSON.stringify({ scripts: { build: 'x' } }), 'yarn.lock': '' })).command, 'yarn build');
    assert.equal(verify.detectCheck(dir('bun', { 'package.json': scripts, 'bun.lock': '' })).command, 'bun run test');
  });
  test('Cargo, Go, pytest (python3 in WSL) and Makefile targets; nothing for an empty folder', () => {
    assert.equal(verify.detectCheck(dir('rust', { 'Cargo.toml': '[package]' })).command, 'cargo test');
    assert.equal(verify.detectCheck(dir('go', { 'go.mod': 'module x' })).command, 'go test ./...');
    assert.deepEqual(verify.detectCheck(dir('py', { 'pyproject.toml': '[tool.pytest.ini_options]\n' })), { command: 'python -m pytest -q', source: 'pyproject.toml' });
    assert.equal(verify.detectCheck(dir('py2', { 'pytest.ini': '' }), { wsl: true }).command, 'python3 -m pytest -q');
    assert.equal(verify.detectCheck(dir('pyplain', { 'pyproject.toml': '[project]\nname="x"\n' })), null);
    assert.equal(verify.detectCheck(dir('make', { Makefile: 'build:\n\tcc x.c\ncheck: build\n\t./x\n' })).command, 'make check');
    assert.equal(verify.detectCheck(dir('empty', {})), null);
  });
  test('parseReview keeps list items only; NO_ISSUES means none', () => {
    assert.deepEqual(verify.parseReview('NO_ISSUES'), []);
    assert.deepEqual(verify.parseReview('  NO_ISSUES.\n'), []);
    assert.deepEqual(verify.parseReview('Some thoughts first.\n- a.js:3: x is never set\n2) b.js:9: off by one'), ['a.js:3: x is never set', 'b.js:9: off by one']);
    assert.deepEqual(verify.parseReview('Looks fine to me overall.'), []);
  });
  test('outputTail keeps the end of long output', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const t = verify.outputTail(long, 200);
    assert.match(t, /^\[… earlier output omitted …\]\n/);
    assert.match(t, /line 1999$/);
    assert.ok(t.length < 260);
  });
});

// =====================================================================================================
describe('tool steps have plain titles', () => {
  const rel = (p) => String(p || '').replace(/^C:\\proj\\/, '');
  const t = (call, res, status) => toolTitle(call, res, status, { rel, summary: 'S' });
  test('done, running, waiting, denied and failed steps', () => {
    assert.deepEqual(t({ name: 'bash', arguments: { command: 'npm test\nmore' } }, null, 'done'), { verb: 'Ran', subject: 'npm test' });
    assert.deepEqual(t({ name: 'bash', arguments: { command: 'npm test' } }, null, 'running'), { verb: 'Running', subject: 'npm test' });
    assert.equal(t({ name: 'bash', arguments: { command: 'npm test' } }, null, 'waiting').verb, 'Run');
    assert.equal(t({ name: 'bash', arguments: { command: 'npm test' } }, null, 'error').verb, 'Ran');
    assert.deepEqual(t({ name: 'edit', arguments: { path: 'C:\\proj\\src\\auth.js' } }, null, 'done'), { verb: 'Edited', subject: 'src\\auth.js' });
    assert.equal(t({ name: 'edit', arguments: { path: 'a.js' } }, null, 'error').verb, 'Could not edit');
    assert.equal(t({ name: 'edit', arguments: { path: 'a.js' } }, null, 'denied').verb, 'Edit');
    assert.equal(t({ name: 'write', arguments: { path: 'n.txt' } }, { content: [{ type: 'text', text: 'Created n.txt (3 bytes, 1 line)' }] }, 'done').verb, 'Created');
    assert.equal(t({ name: 'write', arguments: { path: 'n.txt' } }, { content: [{ type: 'text', text: 'Overwrote n.txt' }] }, 'done').verb, 'Wrote');
    assert.deepEqual(t({ name: 'grep', arguments: { pattern: 'TODO', path: 'src' } }, null, 'done'), { verb: 'Searched for', subject: 'TODO  in src' });
    assert.equal(t({ name: 'glob', arguments: { pattern: '*.ts' } }, null, 'error').verb, 'Could not find files matching');
    assert.equal(t({ name: 'web_search', arguments: { query: 'node 22' } }, null, 'done').verb, 'Searched the web for');
    assert.equal(t({ name: 'task', arguments: { tasks: [{}, {}] } }, null, 'done').verb, 'Ran 2 helper agents');
    assert.equal(t({ name: 'task', arguments: { tasks: [{}] } }, null, 'running').verb, 'Running a helper agent');
    assert.deepEqual(t({ name: 'mcp__db__query', intent: 'db: query', arguments: {} }, null, 'done'), { verb: 'Used', subject: 'db: query' });
  });
});

// =====================================================================================================
describe('run-end checks in the agent loop (mock provider)', () => {
  const ws = path.join(TMP, 'ws');
  let checkCmd = '';
  const config = {
    data: { approvals: 'auto', providers: {}, defaultModel: 'anthropic/claude-test', verify: 'always', review: true },
    provider: (id) => PRESETS.find((p) => p.id === id),
    type: (id) => PRESETS.find((p) => p.id === id)?.type,
    baseUrl: () => 'http://mock.anthropic',
    configured: (id) => id === 'anthropic',
    configuredIds: () => ['anthropic'],
    getKey: async () => 'test-key',
    checkCommand: () => checkCmd,
  };
  const procs = [];
  const make = async (opts = {}) => {
    const p = new AgentProc({ id: 'c' + procs.length, backend: new Backend({ kind: 'native' }), workspace: ws, config, ...opts });
    p.events = [];
    p.on('event', (e) => p.events.push(e));
    procs.push(p);
    await p.start();
    return p;
  };
  const send = async (p, message) => {
    const from = p.events.length;
    await p.request({ type: 'prompt', message });
    for (let i = 0; i < 1500; i++) {
      const end = p.events.slice(from).find((e) => e.type === 'agent_end');
      if (end) return end;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('the run did not end');
  };
  /** Answer questions the agent asks: `answer(title)` returns the option to pick. */
  const answering = (p, answer) => {
    const asked = [];
    p.on('event', (e) => {
      if (e.type !== 'extension_ui_request' || e.method !== 'select') return;
      asked.push(e.title);
      setImmediate(() => p.send({ type: 'extension_ui_response', id: e.id, value: answer(e.title) }));
    });
    return asked;
  };
  const customs = (p, type) => p.messages.filter((m) => m.role === 'custom' && m.customType === type);
  before(() => {
    // Fails while app.txt contains "bug".
    put(path.join(ws, 'check.cjs'), "const t = require('fs').readFileSync('app.txt', 'utf8');\nif (t.includes('bug')) { console.log('FAIL: app.txt has a bug'); process.exit(1); }\nconsole.log('all good');\n");
  });
  after(async () => {
    for (const p of procs) await p.stop();
  });
  const reset = (o = {}) => {
    fs.rmSync(path.join(ws, 'app.txt'), { force: true });
    fs.rmSync(path.join(ws, 'notes.txt'), { force: true });
    Object.assign(config.data, { approvals: 'auto', verify: 'always', review: true }, o);
    checkCmd = 'node check.cjs';
  };

  test('a failing check goes back to the model, which fixes it; the check passes on the next run of it', async () => {
    reset();
    const p = await make();
    const n0 = requests.length;
    script = [
      reply({ tools: [{ id: 'w1', name: 'write', args: { path: 'app.txt', content: 'bug\n' } }], stop: 'tool_use' }),
      reply({ text: 'Done.' }),
      reply({ tools: [{ id: 'e1', name: 'edit', args: { path: 'app.txt', old_string: 'bug', new_string: 'fixed' } }], stop: 'tool_use' }),
      reply({ text: 'Fixed the bug.' }),
    ];
    const end = await send(p, 'make app.txt');
    assert.equal(requests.length - n0, 4, 'one more round after the failed check, no review for a one-line change');
    const third = requests[n0 + 2].body;
    assert.match(userText(third), /ORBIX ran the project's check after your changes, and it failed \(exit code 1\)\.\nCommand: node check\.cjs/);
    assert.match(userText(third), /FAIL: app\.txt has a bug/);
    assert.deepEqual(customs(p, 'verify').map((m) => [m.details.status, m.forModel]), [['failed', true], ['passed', false]]);
    assert.deepEqual(end.checks, { verify: { status: 'passed', command: 'node check.cjs', runs: 2, exitCode: 0 } });
    assert.equal(end.status, 'completed');
    assert.ok(p.events.some((e) => e.method === 'setStatus' && e.statusKey === 'verify' && /node check\.cjs/.test(e.statusText)));
    assert.equal(fs.readFileSync(path.join(ws, 'app.txt'), 'utf8'), 'fixed\n');
  });

  test('a run without edits, or with checks off, runs no check', async () => {
    reset();
    const p = await make();
    script = [reply({ text: 'Just an answer.' })];
    assert.equal((await send(p, 'hi')).checks, undefined);
    reset({ verify: 'off' });
    script = [reply({ tools: [{ id: 'w2', name: 'write', args: { path: 'app.txt', content: 'bug\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    assert.equal((await send(p, 'write it')).checks, undefined);
    assert.equal(customs(p, 'verify').length, 0);
    reset();
    checkCmd = 'off'; // this project has no check
    script = [reply({ tools: [{ id: 'w3', name: 'write', args: { path: 'notes.txt', content: 'x\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    assert.equal((await send(p, 'write notes')).checks, undefined);
  });

  test('Ask: you choose; Run the check needs no second approval, Skip runs nothing', async () => {
    reset({ verify: 'ask', approvals: 'edits' });
    const p = await make();
    let pick = 'Skip';
    const asked = answering(p, () => pick);
    script = [reply({ tools: [{ id: 'w4', name: 'write', args: { path: 'app.txt', content: 'ok\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    let end = await send(p, 'write app');
    assert.deepEqual(asked, ['Check the changes with node check.cjs?']);
    assert.equal(end.checks.verify.status, 'skipped');
    assert.equal(customs(p, 'verify').length, 0);
    pick = 'Run the check';
    script = [reply({ tools: [{ id: 'w5', name: 'write', args: { path: 'notes.txt', content: 'ok\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    end = await send(p, 'write notes');
    assert.equal(asked.length, 2, 'the bash approval was not asked on top');
    assert.equal(end.checks.verify.status, 'passed');
  });

  test('Always: the check is a command like any other and waits for approval; denying it skips the check', async () => {
    reset({ approvals: 'edits' });
    const p = await make();
    const asked = answering(p, () => 'Deny');
    script = [reply({ tools: [{ id: 'w6', name: 'write', args: { path: 'app.txt', content: 'bug\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    const end = await send(p, 'write app');
    assert.deepEqual(asked, ["Run the project's check?  node check.cjs"]);
    assert.equal(end.checks.verify.status, 'skipped');
    assert.ok(p.events.some((e) => e.type === 'notice' && /denied the check/.test(e.message)));
  });

  test('a check the agent already ran after its last edit is not run again', async () => {
    reset();
    const p = await make();
    script = [
      reply({ tools: [{ id: 'w7', name: 'write', args: { path: 'app.txt', content: 'ok\n' } }], stop: 'tool_use' }),
      reply({ tools: [{ id: 'b7', name: 'bash', args: { command: 'node  check.cjs' } }], stop: 'tool_use' }),
      reply({ text: 'Done, and the check passes.' }),
    ];
    const end = await send(p, 'write app and check it');
    assert.deepEqual(end.checks.verify, { status: 'passed', command: 'node check.cjs', runs: 1, exitCode: 0, by: 'agent' });
    assert.equal(customs(p, 'verify')[0].details.by, 'agent');
    assert.ok(!p.events.some((e) => e.method === 'setStatus' && e.statusKey === 'verify' && e.statusText), 'the check did not run');
  });

  test('the review reads the diff and the request; its issues get one more round, and the cost is counted', async () => {
    reset({ verify: 'off' });
    const p = await make();
    const n0 = requests.length;
    script = [
      reply({ tools: [{ id: 'w8', name: 'write', args: { path: 'notes.txt', content: 'one\ntwo\ntwo\nfour\nfive\n' } }], stop: 'tool_use' }),
      reply({ text: 'Wrote the notes.' }),
      reply({ text: '- notes.txt:3: "two" where "three" belongs.' }),
      reply({ tools: [{ id: 'e8', name: 'edit', args: { path: 'notes.txt', old_string: 'two\ntwo', new_string: 'two\nthree' } }], stop: 'tool_use' }),
      reply({ text: 'Fixed line 3.' }),
    ];
    const end = await send(p, 'write notes.txt counting one to five');
    assert.equal(requests.length - n0, 5);
    const rv = requests[n0 + 2].body;
    assert.match(rv.system[0]?.text ?? rv.system, /^You review a code change/);
    assert.deepEqual(rv.tools ?? [], []);
    const asked = userText(rv);
    assert.match(asked, /<request>\nwrite notes\.txt counting one to five\n<\/request>/);
    assert.match(asked, /<diff path=".*notes\.txt">\n\+1\|one\n\+2\|two\n\+3\|two/);
    assert.match(userText(requests[n0 + 3].body), /A review of your changes in this run found a possible defect:\n- notes\.txt:3: "two" where "three" belongs\./);
    assert.deepEqual(end.checks, { review: { status: 'issues', count: 1, fixed: true } });
    assert.equal(end.usage.input, 500, 'the review request counts toward the run');
    const resumed = await make({ resume: p.session.file });
    assert.equal(resumed.usage.input, p.usage.input, 'and toward the session after a restart');
    assert.equal(customs(resumed, 'review')[0].details.issues.length, 1);
  });

  test('a clean review ends the run; a tiny change is not reviewed; review off skips it', async () => {
    reset({ verify: 'off' });
    const p = await make();
    script = [reply({ tools: [{ id: 'w9', name: 'write', args: { path: 'notes.txt', content: 'a\nb\nc\nd\ne\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' }), reply({ text: 'NO_ISSUES' })];
    let end = await send(p, 'write five lines');
    assert.deepEqual(end.checks, { review: { status: 'clean' } });
    assert.equal(customs(p, 'review')[0].forModel, false);
    assert.equal(script.length, 0);
    reset({ verify: 'off' });
    script = [reply({ tools: [{ id: 'w10', name: 'write', args: { path: 'app.txt', content: 'ok\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    end = await send(p, 'one line');
    assert.equal(end.checks, undefined);
    reset({ verify: 'off', review: false });
    script = [reply({ tools: [{ id: 'w11', name: 'write', args: { path: 'notes.txt', content: '1\n2\n3\n4\n5\n6\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' })];
    end = await send(p, 'six lines');
    assert.equal(end.checks, undefined);
    assert.equal(script.length, 0);
  });

  test('a review that fails to run is a note, not an error', async () => {
    reset({ verify: 'off' });
    const p = await make();
    script = [reply({ tools: [{ id: 'w12', name: 'write', args: { path: 'notes.txt', content: '1\n2\n3\n4\n5\n' } }], stop: 'tool_use' }), reply({ text: 'Done.' }), () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 400 })];
    const end = await send(p, 'five lines');
    assert.equal(end.status, 'completed');
    assert.equal(end.checks, undefined);
    assert.ok(p.events.some((e) => e.type === 'notice' && /review of the changes did not run/.test(e.message)));
  });
});
