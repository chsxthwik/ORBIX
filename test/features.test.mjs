// Tests for the power features: model roles, hooks, conversation branching, web_search, /memory, goal mode.
// Mock providers and a mock HTTP server only; nothing leaves this machine.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-feat-test-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
process.env.ORBIX_NO_RG = '1';
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });
const rec = (o) => ({ contextWindow: 200000, maxOutput: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null, ...o });
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: { anthropic: { 'claude-test': rec({}), 'claude-fast': rec({ contextWindow: 100000 }), 'claude-plan': rec({}) } } }));

const realFetch = globalThis.fetch;
const requests = [];
let script = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/mock\.anthropic.*\/models/.test(u)) return new Response(JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Test' }, { id: 'claude-fast', display_name: 'Fast' }], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (/mock\.anthropic/.test(u)) {
    requests.push({ url: u, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    return next(JSON.parse(init.body), init);
  }
  return realFetch(url, init); // the mock HTTP server on 127.0.0.1 (web_search tests)
};

const { AgentProc } = await import('../src/engine/proc.mjs');
const { PRESETS } = await import('../src/engine/providers.mjs');
const { Backend } = await import('../src/backend.mjs');
const store = await import('../src/engine/store.mjs');
const compact = await import('../src/engine/compact.mjs');
const hooks = await import('../src/engine/hooks.mjs');
const { webSearch, parseResults } = await import('../src/engine/websearch.mjs');
const { runSlash, HELP } = await import('../src/engine/slash.mjs');
const { BUILTIN_COMMANDS } = await import('../src/engine/commands.mjs');
const tools = await import('../src/engine/tools.mjs');

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

const enc = new TextEncoder();
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
const sse = (body) => () => new Response(enc.encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
/** One scripted slot that answers by model (a title request and the answer can arrive in either order). */
const byModel = (map) => (body, init) => map[body.model](body, init);
const slowSse = (body, ms) => () => new Response(new ReadableStream({ start(c) { setTimeout(() => (c.enqueue(enc.encode(body)), c.close()), ms); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const ws = path.join(TMP, 'ws');
const makeConfig = (extra = {}) => ({
  data: { approvals: 'auto', providers: {}, defaultModel: 'anthropic/claude-test' },
  provider: (id) => PRESETS.find((p) => p.id === id),
  type: (id) => PRESETS.find((p) => p.id === id)?.type,
  baseUrl: () => 'http://mock.anthropic',
  configured: (id) => id === 'anthropic',
  configuredIds: () => ['anthropic'],
  getKey: async () => 'test-key',
  ...extra,
});
const procs = [];
async function make(config = makeConfig(), opts = {}) {
  fs.mkdirSync(ws, { recursive: true });
  const p = new AgentProc({ id: 'p' + procs.length, backend: new Backend({ kind: 'native' }), workspace: ws, config, ...opts });
  p.events = [];
  p.on('event', (e) => p.events.push(e));
  procs.push(p);
  await p.start();
  return p;
}
async function waitFor(fn, what = 'condition') {
  for (let i = 0; i < 600; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Send a command and wait for the run it starts to end. */
async function runCmd(p, cmd) {
  const from = p.events.length;
  const res = await p.request(cmd);
  assert.equal(res.success, true);
  return waitFor(() => p.events.slice(from).find((e) => e.type === 'agent_end'), 'agent_end');
}
const send = (p, message) => runCmd(p, { type: 'prompt', message });
const idle = (p) => waitFor(() => !p.streaming, 'idle');
after(async () => {
  for (const p of procs) await p.stop();
});
const bodies = (from = 0) => requests.slice(from).map((r) => r.body);

// =====================================================================================================
describe('model roles', () => {
  test('EngineConfig keeps the defaults, shows them to the UI and ignores junk', () => {
    const dir = path.join(TMP, 'roles-cfg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = new store.EngineConfig(dir);
    assert.deepEqual(cfg.roles(), { fast: '', plan: '' });
    cfg.setRoles({ fast: 'anthropic/claude-fast' });
    cfg.setRoles({ plan: ' anthropic/claude-plan ' });
    assert.deepEqual(new store.EngineConfig(dir).roles(), { fast: 'anthropic/claude-fast', plan: 'anthropic/claude-plan' });
    assert.deepEqual(cfg.publicView().models, { fast: 'anthropic/claude-fast', plan: 'anthropic/claude-plan' });
    fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ models: { fast: 5, plan: null } }));
    assert.deepEqual(new store.EngineConfig(dir).roles(), { fast: '', plan: '' });
  });

  test('titles: no fast model means no model call for naming; a fast model names the chat, the main model never does', async () => {
    const p = await make();
    script = [sse(turn({ text: 'Hi.' }))];
    const n = requests.length;
    await send(p, 'please fix the login bug in auth.js');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(requests.length - n, 1, 'only the answer, no title request');
    assert.equal(p.title, 'Fix the login bug in auth.js');

    const q = await make(makeConfig({ roles: () => ({ fast: 'anthropic/claude-fast', plan: '' }) }));
    const both = byModel({ 'claude-test': sse(turn({ text: 'Hi.' })), 'claude-fast': sse(turn({ text: '"Login bug fix".' })) });
    script = [both, both];
    const m = requests.length;
    await send(q, 'please fix the login bug in auth.js');
    await waitFor(() => q.title === 'Login bug fix', 'ai title');
    const models = bodies(m).map((b) => b.model).sort();
    assert.deepEqual(models, ['claude-fast', 'claude-test']);
    assert.ok(q.events.some((e) => e.type === 'session_info_update' && e.title === 'Login bug fix'));
    assert.equal(store.loadSession(q.session.file).title, 'Login bug fix');
  });

  test('a title does not overwrite one you set while it was being written', async () => {
    const q = await make(makeConfig({ roles: () => ({ fast: 'anthropic/claude-fast', plan: '' }) }));
    const both = byModel({ 'claude-test': sse(turn({ text: 'Hi.' })), 'claude-fast': slowSse(turn({ text: 'Model title' }), 400) });
    script = [both, both];
    q.title = '';
    const r = send(q, 'hello there');
    await waitFor(() => q.title);
    await q.request({ type: 'set_session_name', name: 'Mine' });
    await r;
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(q.title, 'Mine');
  });

  test('compaction summaries and helper agents use the fast model; plan mode uses the plan model', async () => {
    const roles = { fast: 'anthropic/claude-fast', plan: 'anthropic/claude-plan' };
    const p = await make(makeConfig({ roles: () => roles }));
    // a long enough conversation to compact
    for (let i = 0; i < 4; i++) {
      const both = byModel({ 'claude-test': sse(turn({ text: `answer ${i} ${'x'.repeat(2000)}`, input: 500 })), 'claude-fast': sse(turn({ text: 'Title' })) });
      script = i === 0 ? [both, both] : [both];
      await send(p, `question ${i} ${'y'.repeat(2000)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
    let n = requests.length;
    script = [sse(turn({ text: 'SUMMARY of the work' }))];
    await runCmd(p, { type: 'prompt', message: '/compact' }).catch(() => {});
    await waitFor(() => p.messages.some((m) => m.role === 'compactionSummary'), 'compaction');
    assert.equal(bodies(n)[0].model, 'claude-fast');
    assert.equal(p.messages.find((m) => m.role === 'compactionSummary').summary, 'SUMMARY of the work');

    // helper agents
    n = requests.length;
    script = [sse(turn({ tools: [{ id: 't1', name: 'task', args: { tasks: [{ task: 'look around' }] } }], stop: 'tool_use' })), sse(turn({ text: 'found nothing' })), sse(turn({ text: 'done' }))];
    await send(p, 'investigate');
    const used = bodies(n).map((b) => b.model);
    assert.deepEqual(used, ['claude-test', 'claude-fast', 'claude-test']);

    // plan mode
    n = requests.length;
    await p.request({ type: 'prompt', message: '/plan' });
    script = [sse(turn({ text: '1. do it' }))];
    await send(p, 'plan the change');
    assert.equal(bodies(n)[0].model, 'claude-plan');
    const asst = p.messages.filter((m) => m.role === 'assistant').at(-1);
    assert.equal(asst.model, 'claude-plan');
    await p.request({ type: 'prompt', message: '/plan' });
  });

  test('a role whose provider is not set up falls back to the current model with one clear note', async () => {
    const p = await make(makeConfig({ roles: () => ({ fast: 'openai/gpt-test', plan: '' }) }));
    script = [sse(turn({ text: 'ok' }))];
    await send(p, 'hello');
    await new Promise((r) => setTimeout(r, 50));
    const notes = p.events.filter((e) => e.type === 'notice' && /fast model/.test(e.message));
    assert.equal(notes.length, 1);
    assert.match(notes[0].message, /OpenAI, which is not set up.*Using the current model/);
  });

  test('/model fast|plan: shows, sets (validated against the model list), clears, and survives a resume', async () => {
    const p = await make();
    p._models = async () => [{ id: 'claude-test', provider: 'anthropic' }, { id: 'claude-fast', provider: 'anthropic' }];
    const out = () => p.events.filter((e) => e.type === 'command_output').at(-1).text;
    await p.request({ type: 'prompt', message: '/model fast' });
    assert.match(out(), /Fast model: not set/);
    await p.request({ type: 'prompt', message: '/model fast anthropic/claude-nope' });
    assert.match(out(), /Could not set the fast model: No model "anthropic\/claude-nope"/);
    assert.equal(p.roles.fast, '');
    await p.request({ type: 'prompt', message: '/model fast claude-fast' });
    assert.match(out(), /Fast model is now \*\*anthropic\/claude-fast\*\* \(this session\)/);
    assert.equal(p.roles.fast, 'anthropic/claude-fast');
    await p.request({ type: 'prompt', message: '/model' });
    assert.match(out(), /Fast model \(titles, summaries, helper agents\): \*\*anthropic\/claude-fast\*\*/);
    const both = byModel({ 'claude-test': sse(turn({ text: 'ok' })), 'claude-fast': sse(turn({ text: 'Named' })) });
    script = [both, both];
    await send(p, 'save this session');
    await waitFor(() => p.title === 'Named', 'title');
    const r = await make(makeConfig(), { resume: p.session.file });
    assert.equal(r.roles.fast, 'anthropic/claude-fast');
    await r.request({ type: 'prompt', message: '/model fast default' });
    assert.equal(r.roles.fast, '');
    assert.match(r.events.filter((e) => e.type === 'command_output').at(-1).text, /Fast model is now .*not set/);
  });
});

// =====================================================================================================
describe('hooks', () => {
  const nodeCmd = (script, ...args) => `"${process.execPath}" "${script}"${args.length ? ' ' + args.join(' ') : ''}`;
  const hooksFile = hooks.userHooksPath();
  const writeHooks = (obj) => fs.writeFileSync(hooksFile, JSON.stringify({ hooks: obj }));
  const projFile = () => hooks.projectHooksPath(ws);
  after(() => fs.rmSync(hooksFile, { force: true }));

  test('file parsing: events, matchers, timeouts, problems are reported not thrown', () => {
    const f = put(path.join(TMP, 'h1.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash|edit', command: 'a' }, { matcher: '(', command: 'bad' }, { command: '' }], Nope: [], Stop: [{ command: 'b', timeout: 99 }, { matcher: '*', command: 'c', timeout: 2 }] } }));
    const r = hooks.readHooksFile(f);
    assert.equal(r.count, 3);
    assert.deepEqual(r.hooks.PreToolUse.map((h) => h.command), ['a']);
    assert.equal(r.hooks.Stop[0].timeout, 10);
    assert.equal(r.hooks.Stop[1].matcher, '');
    assert.equal(r.hooks.Stop[1].timeout, 2);
    assert.equal(r.errors.length, 3);
    assert.ok(r.errors.some((e) => /Unknown event "Nope"/.test(e)));
    assert.equal(hooks.readHooksFile(path.join(TMP, 'missing.json')).exists, false);
    assert.match(hooks.readHooksFile(put(path.join(TMP, 'h2.json'), '{oops')).errors[0], /Not valid JSON/);
    assert.deepEqual(hooks.listHooks(r).map((x) => x.event), ['PreToolUse', 'Stop', 'Stop']);
  });

  test('PreToolUse: exit 2 blocks with stderr for the model, the hook gets JSON on stdin, other tools are unaffected', async () => {
    const stdinFile = path.join(TMP, 'stdin.json');
    const preJs = put(path.join(TMP, 'pre.js'), `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(stdinFile)},d);const j=JSON.parse(d);if(/forbidden/.test(JSON.stringify(j.input))){console.error('no forbidden files');process.exit(2)}})`);
    writeHooks({ PreToolUse: [{ matcher: 'write|edit', command: nodeCmd(preJs) }] });
    const p = await make();
    script = [sse(turn({ tools: [{ id: 'w1', name: 'write', args: { path: 'forbidden.txt', content: 'x' } }], stop: 'tool_use' })), sse(turn({ text: 'blocked, ok' }))];
    await send(p, 'write it');
    const tr = p.messages.find((m) => m.role === 'toolResult');
    assert.equal(tr.isError, true);
    assert.match(tr.content[0].text, /Blocked by a hook: no forbidden files/);
    assert.ok(!fs.existsSync(path.join(ws, 'forbidden.txt')));
    const j = JSON.parse(fs.readFileSync(stdinFile, 'utf8'));
    assert.equal(j.event, 'PreToolUse');
    assert.equal(j.tool, 'write');
    assert.equal(j.input.path, 'forbidden.txt');
    assert.equal(j.cwd, ws);
    assert.equal(j.sessionId, p.sessionId);
    // an allowed call runs; a tool the matcher does not name never starts the hook
    fs.rmSync(stdinFile);
    script = [sse(turn({ tools: [{ id: 'w2', name: 'write', args: { path: 'fine.txt', content: 'ok' } }, { id: 'r1', name: 'glob', args: { pattern: '*.txt' } }], stop: 'tool_use' })), sse(turn({ text: 'done' }))];
    await send(p, 'write another');
    assert.equal(fs.readFileSync(path.join(ws, 'fine.txt'), 'utf8'), 'ok');
    assert.equal(JSON.parse(fs.readFileSync(stdinFile, 'utf8')).tool, 'write');
  });

  test('stdout {"decision":"block","reason"} blocks too; a failing hook (exit 1) only warns', async () => {
    const blockJs = put(path.join(TMP, 'blockjson.js'), `console.log(JSON.stringify({decision:'block',reason:'policy says no'}))`);
    const failJs = put(path.join(TMP, 'fail.js'), `console.error('boom');process.exit(1)`);
    writeHooks({ PreToolUse: [{ matcher: 'bash', command: nodeCmd(failJs) }, { matcher: 'bash', command: nodeCmd(blockJs) }] });
    const p = await make();
    script = [sse(turn({ tools: [{ id: 'b1', name: 'bash', args: { command: 'echo hi' } }], stop: 'tool_use' })), sse(turn({ text: 'ok' }))];
    await send(p, 'run');
    assert.match(p.messages.find((m) => m.role === 'toolResult').content[0].text, /Blocked by a hook: policy says no/);
    const warn = p.events.find((e) => e.type === 'notice' && /hook failed \(exit code 1\): boom/.test(e.message));
    assert.ok(warn);
  });

  test('a hook that runs too long is stopped after its timeout and ignored', async () => {
    const slow = put(path.join(TMP, 'slow.js'), `setTimeout(()=>{},30000)`);
    writeHooks({ PreToolUse: [{ matcher: 'glob', command: nodeCmd(slow), timeout: 1 }] });
    const p = await make();
    script = [sse(turn({ tools: [{ id: 'g1', name: 'glob', args: { pattern: '*.nothing' } }], stop: 'tool_use' })), sse(turn({ text: 'ok' }))];
    const t0 = Date.now();
    await send(p, 'look');
    assert.ok(Date.now() - t0 < 8000);
    assert.ok(p.events.some((e) => e.type === 'notice' && /took longer than 1 s/.test(e.message)));
    assert.equal(p.messages.find((m) => m.role === 'toolResult').isError, false);
  });

  test('PostToolUse feedback reaches the model; its output is capped', async () => {
    const post = put(path.join(TMP, 'post.js'), `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.error('lint: '+j.result.text.slice(0,20)+' '+'z'.repeat(40000));process.exit(2)})`);
    writeHooks({ PostToolUse: [{ matcher: 'write', command: nodeCmd(post) }] });
    const p = await make();
    script = [sse(turn({ tools: [{ id: 'w1', name: 'write', args: { path: 'post.txt', content: 'x' } }], stop: 'tool_use' })), sse(turn({ text: 'ok' }))];
    await send(p, 'write');
    const text = p.messages.find((m) => m.role === 'toolResult').content[0].text;
    assert.match(text, /\[Hook feedback\] lint: /);
    assert.ok(text.length < 4000, 'capped');
  });

  test('UserPromptSubmit can block a message; Stop can ask for one more step (once)', async () => {
    const gate = put(path.join(TMP, 'gate.js'), `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{if(JSON.parse(d).input.prompt.includes('secret')){console.error('no secrets');process.exit(2)}})`);
    const stop = put(path.join(TMP, 'stop.js'), `console.error('run the tests first');process.exit(2)`);
    writeHooks({ UserPromptSubmit: [{ command: nodeCmd(gate) }], Stop: [{ command: nodeCmd(stop) }] });
    const p = await make();
    const n = requests.length;
    await send(p, 'tell me the secret');
    assert.equal(requests.length, n);
    assert.equal(p.messages.length, 0);
    assert.ok(p.events.some((e) => e.type === 'notice' && /A hook blocked this message: no secrets/.test(e.message)));
    script = [sse(turn({ text: 'first' })), sse(turn({ text: 'second' }))];
    await send(p, 'hello');
    assert.equal(requests.length - n, 2);
    assert.match(JSON.stringify(bodies(n)[1].messages.at(-1)), /A Stop hook asks you to continue: run the tests first/);
    assert.equal(p.messages.at(-1).content[0].text, 'second');
  });

  test('project hooks: nothing runs until you allow them; "Allow and remember" is kept for that exact file', async () => {
    fs.rmSync(hooksFile, { force: true });
    const mark = path.join(TMP, 'proj-ran.txt');
    const script_ = put(path.join(TMP, 'proj.js'), `require('fs').appendFileSync(${JSON.stringify(mark)},'x')`);
    put(projFile(), JSON.stringify({ hooks: { UserPromptSubmit: [{ command: nodeCmd(script_) }] } }));
    try {
      const asked = [];
      const p = await make();
      p._askUser = async (title, options) => (asked.push({ title, options }), 'Do not run');
      p.hooks.ask = p._askUser;
      script = [sse(turn({ text: 'a' })), sse(turn({ text: 'b' }))];
      await send(p, 'one');
      await send(p, 'two');
      assert.equal(asked.length, 1, 'asked once per session');
      assert.match(asked[0].title, /\.orbix\/hooks\.json wants to run commands.*UserPromptSubmit: .*proj\.js/);
      assert.deepEqual(asked[0].options, ['Allow and remember', 'Allow once', 'Do not run']);
      assert.ok(!fs.existsSync(mark));

      const q = await make();
      q.hooks.ask = async () => 'Allow and remember';
      script = [sse(turn({ text: 'c' }))];
      await send(q, 'three');
      assert.equal(fs.readFileSync(mark, 'utf8'), 'x');

      const r = await make();
      r.hooks.ask = async () => assert.fail('already trusted: must not ask again');
      script = [sse(turn({ text: 'd' }))];
      await send(r, 'four');
      assert.equal(fs.readFileSync(mark, 'utf8'), 'xx');

      // a changed file is a new question
      put(projFile(), JSON.stringify({ hooks: { UserPromptSubmit: [{ command: nodeCmd(script_) + ' --changed' }] } }));
      const s = await make();
      let again = 0;
      s.hooks.ask = async () => (again++, 'Allow once');
      script = [sse(turn({ text: 'e' }))];
      await send(s, 'five');
      assert.equal(again, 1);
    } finally {
      fs.rmSync(path.dirname(projFile()), { recursive: true, force: true });
    }
  });

  test('the trust question shows every command, long ones keep start and end', () => {
    const text = hooks.describeHooks({ PreToolUse: [{ matcher: 'bash', command: 'echo ' + 'a'.repeat(2000) + ' && curl evil.example' }] });
    assert.match(text, /^PreToolUse\[bash\]: echo a+/);
    assert.match(text, /characters not shown/);
    assert.match(text, /curl evil\.example$/);
  });
});

// =====================================================================================================
describe('branching', () => {
  test('branchSession keeps what is before the message, replays compaction and rewind like the original, and never edits the source', () => {
    const f = path.join(TMP, 'sessions', 'a', 'src.jsonl');
    const msg = (role, text, extra = {}) => ({ type: 'message', message: { role, id: `${role[0]}${text}`, content: [{ type: 'text', text }], ...extra } });
    const lines = [
      { type: 'session', engine: 'builtin', version: 1, id: 'b1', cwd: 'C:\\x', model: 'm', provider: 'anthropic' },
      { type: 'title', title: 'Orig' },
      msg('user', 'u1'), msg('assistant', 'a1'),
      msg('user', 'u2'), { type: 'checkpoint', toolCallId: 'c1', undo: { path: 'f', before: null, afterHash: 'h' } }, msg('assistant', 'a2'),
      msg('user', 'u3'), msg('assistant', 'a3'),
      { type: 'rewind', count: 4, dropped: {} }, // u3 and a3 dropped again
      msg('user', 'u3b'), msg('assistant', 'a3b'),
      { type: 'compaction', summary: 'S', keptCount: 2, tokensBefore: 1 },
    ];
    put(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const before = fs.readFileSync(f, 'utf8');
    const full = compact.rebuildSession(f).messages;
    assert.deepEqual(full.map((m) => m.role === 'compactionSummary' ? 'S' : m.content[0].text), ['u1', 'a1', 'u2', 'a2', 'S', 'u3b', 'a3b']);
    // index of u3b in the live list (marker counted)
    const at = full.findIndex((m) => m.content?.[0]?.text === 'u3b');
    const r = store.branchSession(f, at, { title: 'Orig (branch)' });
    const got = compact.rebuildSession(r.file).messages.map((m) => (m.role === 'compactionSummary' ? 'S' : m.content[0].text));
    assert.deepEqual(got, ['u1', 'a1', 'u2', 'a2']);
    const s = store.loadSession(r.file);
    assert.equal(s.title, 'Orig (branch)');
    assert.equal(s.header.id, r.id);
    assert.notEqual(r.id, 'b1');
    assert.equal(s.checkpoints.length, 1);
    assert.equal(fs.readFileSync(f, 'utf8'), before);
    // the first message: an empty session; past the end: everything
    assert.equal(compact.rebuildSession(store.branchSession(f, 0).file).messages.length, 0);
    assert.equal(compact.rebuildSession(store.branchSession(f, full.length).file).messages.length, full.length);
    assert.throws(() => store.branchSession(f, full.length + 1), /not found/);
    assert.throws(() => store.branchSession(f, -1), /not found/);
  });

  test('AgentProc: branch from a user message makes a resumable session, keeps the title, opens via branch_created, files untouched', async () => {
    const p = await make();
    script = [sse(turn({ tools: [{ id: 'w', name: 'write', args: { path: 'branch.txt', content: 'one' } }], stop: 'tool_use' })), sse(turn({ text: 'wrote' })), sse(turn({ text: 'second answer' }))];
    await send(p, 'create branch.txt');
    await send(p, 'now do the second thing');
    const second = p.messages.filter((m) => m.role === 'user')[1];
    const res = await p.request({ type: 'branch', messageId: second.id });
    assert.equal(res.success, true);
    const d = res.data;
    assert.match(d.title, / \(branch\)$/);
    assert.equal(d.text, 'now do the second thing');
    assert.ok(fs.existsSync(d.path));
    const evn = p.events.find((e) => e.type === 'branch_created');
    assert.equal(evn.path, d.path);
    assert.equal(fs.readFileSync(path.join(ws, 'branch.txt'), 'utf8'), 'one');
    const b = await make(makeConfig(), { resume: d.path });
    assert.equal(b.title, d.title);
    assert.deepEqual(b.messages.map((m) => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(b.checkpoints.size, 1);
    assert.notEqual(b.sessionId, p.sessionId);
    // branching a branch does not stack the suffix; the branch continues on its own
    script = [sse(turn({ text: 'different second' }))];
    await send(b, 'try a different second thing');
    const again = (await b.request({ type: 'branch' })).data;
    assert.equal(again.title, d.title);
    // the listing shows it with the branch title
    const list = await store.listAgentSessions(new Backend({ kind: 'native' }));
    assert.ok(list.some((s) => s.path === d.path && s.title === d.title));
    await assert.rejects(() => p.request({ type: 'branch', messageId: 'nope' }), /not found/);
  });

  test('/branch works from the command line of the session; an unsaved conversation says so', async () => {
    const p = await make();
    script = [sse(turn({ text: 'hi' }))];
    await send(p, 'hello');
    await p.request({ type: 'prompt', message: '/branch' });
    const e = p.events.find((x) => x.type === 'branch_created');
    assert.ok(e && e.text === '');
    assert.match(p.events.filter((x) => x.type === 'command_output').at(-1).text, /Branch created/);
    const fresh = await make(makeConfig(), { noSession: true });
    await fresh.request({ type: 'prompt', message: '/branch' });
    assert.match(fresh.events.filter((x) => x.type === 'command_output').at(-1).text, /Could not branch: This conversation is not saved yet/);
  });
});

// =====================================================================================================
describe('web_search', () => {
  let srv;
  let base;
  const seen = [];
  before(async () => {
    srv = http.createServer((req, res) => {
      seen.push({ url: req.url, method: req.method, headers: req.headers });
      const send = (code, obj, extra = {}) => (res.writeHead(code, { 'content-type': 'application/json', ...extra }), res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)));
      if (req.url.startsWith('/brave')) {
        if (req.headers['x-subscription-token'] !== 'brave-key') return send(401, { error: 'bad key' });
        return send(200, { web: { results: [{ title: '<b>Node</b> docs &amp; more', url: 'https://nodejs.org/docs', description: 'The <strong>docs</strong>' }, { title: 'Bad', url: 'javascript:alert(1)', description: 'x' }, ...Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://e.example/${i}`, description: 'd'.repeat(2000) }))] } });
      }
      if (req.url.startsWith('/tavily')) {
        let body = '';
        req.on('data', (c) => (body += c)).on('end', () => (req.headers.authorization === 'Bearer tav-key' ? send(200, { results: [{ title: 'Tav', url: 'https://t.example/a', content: 'snippet ' + JSON.parse(body).query }] }) : send(403, {})));
        return;
      }
      if (req.url.startsWith('/searx/search')) return send(200, { results: [{ title: 'S', url: 'http://localhost/page', content: 'local' }] });
      if (req.url.startsWith('/redirect')) return send(302, '', { location: 'http://127.0.0.1:1/private' });
      if (req.url.startsWith('/html')) return send(200, '<html>nope</html>');
      if (req.url.startsWith('/limit')) return send(429, {});
      if (req.url.startsWith('/huge')) return send(200, 'x'.repeat(3 * 1024 * 1024));
      if (req.url.startsWith('/empty')) return send(200, { web: { results: [] } });
      send(404, {});
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  test('Brave: sends the key as a header, strips markup, drops non-http links, caps count and snippet size', async () => {
    const r = await webSearch({ query: 'node docs', count: 3 }, { provider: 'brave', apiKey: 'brave-key', baseUrl: `${base}/brave` });
    assert.equal(r.isError, undefined);
    assert.equal(r.details.count, 3);
    assert.match(r.text, /^1\. Node docs & more\n   https:\/\/nodejs\.org\/docs\n   The docs\n2\. T0/);
    assert.doesNotMatch(r.text, /javascript:/);
    assert.ok(r.text.length < 3 * 500 + 200);
    const big = await webSearch({ query: 'x', count: 99 }, { provider: 'brave', apiKey: 'brave-key', baseUrl: `${base}/brave` });
    assert.equal(big.details.count, 10);
    const last = seen.filter((s) => s.url.startsWith('/brave')).at(-1);
    assert.match(last.url, /q=x&count=10/);
  });

  test('Tavily (POST + bearer) and SearXNG (JSON, a private address is the user\'s own choice)', async () => {
    const t = await webSearch({ query: 'hello world' }, { provider: 'tavily', apiKey: 'tav-key', baseUrl: `${base}/tavily` });
    assert.match(t.text, /1\. Tav\n   https:\/\/t\.example\/a\n   snippet hello world/);
    const s = await webSearch({ query: 'local' }, { provider: 'searxng', baseUrl: `${base}/searx/` });
    assert.match(s.text, /1\. S\n   http:\/\/localhost\/page/);
    assert.match(seen.at(-1).url, /^\/searx\/search\?q=local&format=json$/);
  });

  test('errors say what to do: bad key, rate limit, redirect refused, not JSON, empty query, too much data, no results', async () => {
    const bad = await webSearch({ query: 'q' }, { provider: 'brave', apiKey: 'wrong', baseUrl: `${base}/brave` });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Brave Search answered 401\. Check the key in Settings/);
    assert.doesNotMatch(bad.text, /wrong/);
    assert.match((await webSearch({ query: 'q' }, { provider: 'brave', apiKey: 'k', baseUrl: `${base}/limit` })).text, /429.*try again later/);
    const red = await webSearch({ query: 'q' }, { provider: 'searxng', baseUrl: `${base}/redirect-x` });
    assert.equal(red.isError, true);
    assert.equal(seen.filter((s) => s.url.startsWith('/private')).length, 0);
    assert.match((await webSearch({ query: 'q' }, { provider: 'searxng', baseUrl: `${base}/html` })).text, /did not send JSON.*search\.formats/);
    assert.match((await webSearch({ query: '  ' }, { provider: 'brave', apiKey: 'k' })).text, /query is empty/);
    assert.match((await webSearch({ query: 'q' }, { provider: 'brave', apiKey: 'k', baseUrl: `${base}/huge` })).text, /too much data/);
    assert.match((await webSearch({ query: 'q' }, { provider: 'brave', apiKey: 'brave-key', baseUrl: `${base}/empty` })).text, /No results for "q"/);
    assert.match((await webSearch({ query: 'q' }, { provider: '' })).text, /not set up/);
    assert.match((await webSearch({ query: 'q' }, { provider: 'brave', apiKey: 'k', baseUrl: 'http://127.0.0.1:1/x' })).text, /Could not reach Brave Search/);
  });

  test('parseResults ignores junk', () => {
    assert.deepEqual(parseResults('brave', null), []);
    assert.deepEqual(parseResults('tavily', { results: [{ title: 'x' }, { url: 'ftp://x' }] }), []);
  });

  test('the tool is hidden from the model until a service is set up, then it runs without asking and reaches subagents', async () => {
    const off = await make();
    assert.ok(!off._toolDefs().some((d) => d.name === 'web_search'));
    assert.ok(!(await off.request({ type: 'get_state' })).data.tools.includes('web_search'));
    script = [sse(turn({ tools: [{ id: 's1', name: 'web_search', args: { query: 'x' } }], stop: 'tool_use' })), sse(turn({ text: 'ok' }))];
    await send(off, 'search');
    assert.match(off.messages.find((m) => m.role === 'toolResult').content[0].text, /Unknown tool "web_search"/);

    const cfg = makeConfig({ searchReady: () => true, searchConfig: async () => ({ provider: 'tavily', apiKey: 'tav-key', baseUrl: `${base}/tavily` }) });
    cfg.data.approvals = 'ask';
    const on = await make(cfg);
    assert.ok(on._toolDefs().some((d) => d.name === 'web_search'));
    assert.ok(tools.READ_ONLY.has('web_search') && !tools.NEEDS_APPROVAL.has('web_search'));
    let n = requests.length;
    script = [sse(turn({ tools: [{ id: 's2', name: 'web_search', args: { query: 'mock query' } }], stop: 'tool_use' })), sse(turn({ text: 'found it' }))];
    await send(on, 'search');
    assert.equal(on.events.filter((e) => e.type === 'extension_ui_request' && e.method === 'select').length, 0, 'no approval question');
    assert.match(on.messages.find((m) => m.role === 'toolResult').content[0].text, /snippet mock query/);
    assert.ok(bodies(n)[0].tools.some((t) => t.name === 'web_search'));
    // subagents get it too
    n = requests.length;
    script = [sse(turn({ tools: [{ id: 't', name: 'task', args: { tasks: [{ task: 'look' }] } }], stop: 'tool_use' })), sse(turn({ text: 'sub done' })), sse(turn({ text: 'fin' }))];
    await send(on, 'delegate');
    assert.ok(bodies(n)[1].tools.some((t) => t.name === 'web_search'));
  });

  test('EngineConfig: key and address are validated, kept encrypted, and never shown to the UI', { skip: process.platform !== 'win32' && 'DPAPI is Windows-only', timeout: 60000 }, async () => {
    const dir = path.join(TMP, 'search-cfg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = new store.EngineConfig(dir);
    assert.equal(cfg.searchReady(), false);
    await assert.rejects(() => cfg.setSearch({ provider: 'brave' }), /Paste an API key/);
    await assert.rejects(() => cfg.setSearch({ provider: 'searxng', baseUrl: 'ftp://x' }), /must start with http/);
    await assert.rejects(() => cfg.setSearch({ provider: 'searxng', baseUrl: 'http://user:pw@host' }), /user name and password/);
    await assert.rejects(() => cfg.setSearch({ provider: 'bing', key: 'k' }), /Choose Brave/);
    await cfg.setSearch({ provider: 'brave', key: 'brave-secret-1' });
    assert.equal(cfg.searchReady(), true);
    const file = fs.readFileSync(path.join(dir, 'engine.json'), 'utf8');
    assert.match(file, /dpapi:/);
    assert.doesNotMatch(file, /brave-secret-1/);
    assert.doesNotMatch(JSON.stringify(cfg.publicView()), /secret|dpapi/);
    assert.deepEqual(cfg.publicView().search, { provider: 'brave', baseUrl: '', hasKey: true, configured: true });
    assert.equal((await new store.EngineConfig(dir).searchConfig()).apiKey, 'brave-secret-1');
    await cfg.setSearch({ provider: 'searxng', baseUrl: 'http://localhost:8080/' });
    assert.equal((await cfg.searchConfig()).baseUrl, 'http://localhost:8080');
    cfg.clearSearch();
    assert.equal(cfg.searchReady(), false);
    assert.equal(new store.EngineConfig(dir).data.search, null);
  });
});

// =====================================================================================================
describe('slash commands: /help /memory /init /hooks /goal', () => {
  test('are listed for autocomplete and /help covers every new feature, including how to enable web search', async () => {
    for (const n of ['branch', 'goal', 'memory', 'hooks', 'model', 'init']) assert.ok(BUILTIN_COMMANDS.some((c) => c.name === n && c.description), n);
    for (const w of ['/model fast|plan', '/branch', '/goal', '/memory', '/hooks', '/init']) assert.ok(HELP.includes(w), w);
    const out = [];
    const a = { _out: (t) => out.push(t), _searchOn: () => false };
    await runSlash(a, '/help');
    assert.match(out[0], /`web_search` is off\. Turn it on in Settings → Tools & MCP → Web search/);
    await runSlash({ _out: (t) => out.push(t), _searchOn: () => true }, '/help');
    assert.match(out[1], /`web_search` is on/);
  });

  test('/init asks the agent to write or refresh AGENTS.md; /memory shows where the file is', async () => {
    const r = await runSlash({ workspace: 'x', backend: { hostPath: () => ws }, _out: () => {} }, '/init');
    assert.match(r.text, /AGENTS\.md/);
    assert.match(r.text, /refresh it/);
    const out = [];
    const mem = path.join(TMP, 'memws');
    fs.mkdirSync(mem, { recursive: true });
    const agent = { workspace: mem, backend: { hostPath: (p) => p, keyPath: (p) => p }, _out: (t) => out.push(t) };
    await runSlash(agent, '/memory');
    assert.match(out[0], /AGENTS\.md` does not exist yet\. Type \/init/);
    put(path.join(mem, 'AGENTS.md'), 'Rules');
    await runSlash(agent, '/memory');
    assert.match(out[1], /AGENTS\.md` \(5 bytes\)\. It is loaded into every session/);
  });

  test('/hooks lists your hooks and the project\'s', async () => {
    const f = hooks.userHooksPath();
    fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'bash', command: 'echo hi' }] } }));
    try {
      const out = [];
      await runSlash({ workspace: ws, backend: { hostPath: () => ws, keyPath: (p) => p }, _out: (t) => out.push(t) }, '/hooks');
      assert.match(out[0], /\*\*PreToolUse\*\* \[bash\]: `echo hi`/);
      assert.match(out[0], /file not found/);
    } finally {
      fs.rmSync(f, { force: true });
    }
  });
});

describe('goal mode', () => {
  test('keeps going until GOAL_DONE, one round per follow-up, with progress notes and a status line', async () => {
    const p = await make();
    script = [sse(turn({ text: 'Started step one.' })), sse(turn({ text: 'Step two done.' })), sse(turn({ text: 'All finished.\n\nGOAL_DONE' }))];
    const end = await runCmd(p, { type: 'prompt', message: '/goal make the thing work' });
    await waitFor(() => !p.goal && !p.streaming, 'goal end');
    assert.equal(requests.slice(-3).length, 3);
    const users = p.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 3);
    assert.ok(users.every((m) => m.attribution === 'goal'));
    assert.match(users[0].content[0].text, /^\[Goal round 1\/6\]\nGoal: make the thing work/);
    assert.match(users[2].content[0].text, /^\[Goal round 3\/6\]\nContinue working toward the goal: make the thing work/);
    const notes = p.events.filter((e) => e.type === 'notice').map((e) => e.message);
    assert.ok(notes.some((m) => /Goal round 2 of 6/.test(m)));
    assert.ok(notes.some((m) => /Goal reached after 3 rounds/.test(m)));
    const status = p.events.filter((e) => e.method === 'setStatus' && e.statusKey === 'goal');
    assert.match(status[0].statusText, /Goal 1\/6.*Esc/);
    assert.equal(status.at(-1).statusText, '');
    assert.equal(p.title, 'Make the thing work');
    assert.equal(end.status, 'completed');
  });

  test('a question pauses it; the limit is 6 rounds; an error ends it', async () => {
    const q = await make();
    script = [sse(turn({ text: 'Which database should I use?' }))];
    await send(q, '/goal add storage');
    await waitFor(() => !q.goal, 'goal end');
    assert.ok(q.events.some((e) => e.type === 'notice' && /Goal paused: the agent asked you a question/.test(e.message)));
    assert.equal(q.messages.filter((m) => m.role === 'user').length, 1);

    const lim = await make();
    const n = requests.length;
    script = Array.from({ length: 8 }, (_, i) => sse(turn({ text: `still going ${i}` })));
    await send(lim, '/goal never ends');
    await waitFor(() => !lim.goal && !lim.streaming, 'limit');
    assert.equal(requests.length - n, 6);
    assert.ok(lim.events.some((e) => e.type === 'notice' && /Goal stopped after 6 rounds without GOAL_DONE/.test(e.message)));
    script = [];

    const err = await make();
    script = [() => new Response('{"error":{"message":"bad request"}}', { status: 400, headers: { 'content-type': 'application/json' } })];
    await send(err, '/goal fail');
    await waitFor(() => !err.goal, 'error end');
    assert.ok(err.events.some((e) => e.type === 'notice' && /Goal stopped because of an error/.test(e.message)));
  });

  test('Esc (abort) stops it and drops the queued round; a message you type takes over; it is off unless invoked', async () => {
    const p = await make();
    assert.equal(p.goal, null);
    script = [
      (body, init) => new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(turn({ text: 'working' }).slice(0, 200))); init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ];
    await p.request({ type: 'prompt', message: '/goal long task' });
    await waitFor(() => p.streaming && p.goal, 'running');
    await p.request({ type: 'abort' });
    await waitFor(() => !p.streaming, 'aborted');
    assert.equal(p.goal, null);
    assert.equal(p.queue.followUp.length, 0);
    assert.ok(p.events.some((e) => e.type === 'notice' && /Goal stopped\./.test(e.message)));

    const t = await make();
    script = [sse(turn({ text: 'round one' })), sse(turn({ text: 'my answer' }))];
    // a normal message while a goal is set ends goal mode
    t.goal = { text: 'x', round: 2, max: 6 };
    await send(t, 'something else');
    assert.equal(t.goal, null);
    assert.ok(t.events.some((e) => e.type === 'notice' && /ended because you sent a message/.test(e.message)));
  });

  test('/goal with no text explains itself; /goal stop when nothing runs says so', async () => {
    const out = [];
    const a = { _out: (t) => out.push(t), goal: null, streaming: false };
    await runSlash(a, '/goal');
    assert.match(out[0], /Usage: `\/goal <what to achieve>`/);
    await runSlash(a, '/goal stop');
    assert.match(out[1], /No goal is running/);
  });
});

// =====================================================================================================
describe('server routes: models, search, hooks', () => {
  let srv;
  let port;
  let mock;
  let mockBase;
  const TOKEN = 'b'.repeat(48);
  const call = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, cookie: `orbix=${TOKEN}`, ...(method === 'GET' ? {} : { 'x-orbix': '1', 'content-type': 'application/json' }), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c)).on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t || '{}') }));
      });
      r.on('error', reject);
      r.end(data);
    });
  before(async () => {
    const { Store } = await import('../src/store.mjs');
    const { AppServer } = await import('../src/server.mjs');
    const st = new Store();
    st.data.backend = { kind: 'native', distro: '' };
    st.data.backendChosen = true;
    srv = new AppServer({ store: st, token: TOKEN });
    port = await srv.listen(0);
    srv.engineCfg.configured = (id) => id === 'anthropic';
    srv.engineCfg.configuredIds = () => ['anthropic'];
    srv.engineCfg.getKey = async () => 'k';
    srv.engineCfg.baseUrl = () => 'http://mock.anthropic';
    mock = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ title: 'ok', url: 'https://ok.example/', content: 'c' }] }));
    });
    await new Promise((r) => mock.listen(0, '127.0.0.1', r));
    mockBase = `http://127.0.0.1:${mock.address().port}`;
  });
  after(async () => {
    mock.close();
    await srv.shutdown();
  });

  test('models: lists what the providers offer; saves only ids the provider really has; says what is wrong', async () => {
    const list = await call('GET', '/api/engine/models');
    assert.deepEqual(list.json.models.map((m) => m.id), ['claude-test', 'claude-fast']);
    assert.equal(list.json.models[0].providerName, 'Anthropic');
    let r = await call('POST', '/api/engine/models', { fast: 'claude-fast' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /provider\/model-id, for example anthropic\/claude-haiku-4-5/);
    r = await call('POST', '/api/engine/models', { fast: 'openai/gpt-test' });
    assert.match(r.json.error, /OpenAI is not set up/);
    r = await call('POST', '/api/engine/models', { fast: 'anthropic/claude-nope' });
    assert.match(r.json.error, /Anthropic has no model "claude-nope"/);
    assert.deepEqual(srv.engineCfg.roles(), { fast: '', plan: '' });
    r = await call('POST', '/api/engine/models', { fast: 'anthropic/claude-fast', plan: 'anthropic/claude-test' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.engine.models, { fast: 'anthropic/claude-fast', plan: 'anthropic/claude-test' });
    r = await call('POST', '/api/engine/models', { fast: '' });
    assert.deepEqual(r.json.engine.models, { fast: '', plan: 'anthropic/claude-test' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'engine.json'), 'utf8')).models, { fast: '', plan: 'anthropic/claude-test' });
  });

  test('search: the service is tried before it is saved; a bad address or key is refused; clear turns it off', async () => {
    let r = await call('POST', '/api/engine/search', { provider: 'brave' });
    assert.match(r.json.error, /Paste an API key/);
    r = await call('POST', '/api/engine/search', { provider: 'searxng', baseUrl: 'localhost:8080' });
    assert.match(r.json.error, /must start with http/);
    r = await call('POST', '/api/engine/search', { provider: 'searxng', baseUrl: 'http://127.0.0.1:1' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Could not reach SearXNG/);
    assert.equal(srv.engineCfg.searchReady(), false);
    r = await call('POST', '/api/engine/search', { provider: 'searxng', baseUrl: mockBase });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.engine.search, { provider: 'searxng', baseUrl: mockBase, hasKey: false, configured: true });
    assert.equal((await call('GET', '/api/engine')).json.engine.search.configured, true);
    r = await call('POST', '/api/engine/search/clear', {});
    assert.equal(r.json.engine.search.configured, false);
  });

  test('hooks: shows both files with problems and whether the project ones were allowed', async () => {
    const proj = path.join(TMP, 'hookws');
    put(path.join(proj, '.orbix', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ command: 'echo done' }], Bogus: [] } }));
    fs.rmSync(hooks.userHooksPath(), { force: true });
    const r = await call('GET', `/api/hooks?ws=${encodeURIComponent(proj)}`);
    assert.equal(r.json.user.exists, false);
    assert.equal(r.json.project.exists, true);
    assert.deepEqual(r.json.project.hooks.map((h) => [h.event, h.command]), [['Stop', 'echo done']]);
    assert.match(r.json.project.errors[0], /Unknown event "Bogus"/);
    assert.equal(r.json.project.trusted, false);
    assert.equal((await call('GET', '/api/hooks')).json.project, null);
  });
});
