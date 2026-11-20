// Rules with triggers (.agents/rules/*.md) and the hook events and JSON decisions added for parity item 3.13 / 3.16.
// Mock provider only; nothing leaves this machine.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-rules-test-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
process.env.ORBIX_NO_RG = '1';
fs.mkdirSync(path.join(DATA, 'cache'), { recursive: true });
const rec = (o) => ({ contextWindow: 200000, maxOutput: 8192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, reasoning: false, vision: true, tools: true, efforts: null, budget: false, toggle: false, interleaved: null, canonical: null, ...o });
fs.writeFileSync(path.join(DATA, 'cache', 'models-dev.json'), JSON.stringify({ fetchedAt: Date.now(), providers: { anthropic: { 'claude-test': rec({}) } } }));

const realFetch = globalThis.fetch;
const requests = [];
let script = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/mock\.anthropic.*\/models/.test(u)) return new Response(JSON.stringify({ data: [{ id: 'claude-test', display_name: 'Test' }], has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  if (/mock\.anthropic/.test(u)) {
    requests.push({ url: u, body: JSON.parse(init.body) });
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    return next(JSON.parse(init.body), init);
  }
  return realFetch(url, init);
};

const { AgentProc } = await import('../src/engine/proc.mjs');
const { PRESETS } = await import('../src/engine/providers.mjs');
const { Backend } = await import('../src/backend.mjs');
const hooks = await import('../src/engine/hooks.mjs');
const rulesMod = await import('../src/engine/rules.mjs');
const { parseFrontmatter } = await import('../src/engine/skills.mjs');
const { runSlash } = await import('../src/engine/slash.mjs');

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
function turn({ text = '', tools = [], stop = 'end_turn' }) {
  const out = [ev('message_start', { message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })];
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
  out.push(ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 20 } }));
  out.push(ev('message_stop', {}));
  return out.join('');
}
const sse = (body) => () => new Response(enc.encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const reply = (text) => sse(turn({ text }));
const calls = (...tools) => sse(turn({ tools, stop: 'tool_use' }));

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
let wsSeq = 0;
/** A fresh project folder that is its own repository root (so rule lookup never walks above it). */
function newWs(name = `ws${wsSeq++}`) {
  const ws = path.join(TMP, name);
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  return ws;
}
async function make(ws, config = makeConfig()) {
  const p = new AgentProc({ id: 'p' + procs.length, backend: new Backend({ kind: 'native' }), workspace: ws, config });
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
async function send(p, message) {
  const from = p.events.length;
  const res = await p.request({ type: 'prompt', message });
  assert.equal(res.success, true);
  return waitFor(() => p.events.slice(from).find((e) => e.type === 'agent_end'), 'agent_end');
}
after(async () => {
  for (const p of procs) await p.stop();
});
const bodies = (from = 0) => requests.slice(from).map((r) => r.body);
const systemOf = (body) => body.system.map((b) => b.text).join('\n');
const toolResults = (p) => p.messages.filter((m) => m.role === 'toolResult').map((m) => m.content[0].text);

// =====================================================================================================
describe('rule files: frontmatter and triggers', () => {
  const info = { name: 'r', path: 'r.md', hostPath: 'r.md', scope: 'project' };

  test('no frontmatter, or frontmatter without a trigger, is not a rule', () => {
    assert.match(rulesMod.parseRule('Just text, no frontmatter.', info).error, /no frontmatter with a trigger/);
    assert.match(rulesMod.parseRule('---\ndescription: x\n---\nbody', info).error, /no frontmatter with a trigger/);
    assert.deepEqual(parseFrontmatter('plain').meta, {});
  });

  test('CRLF line endings, a BOM, and quoted values', () => {
    const r = rulesMod.parseRule('\ufeff---\r\ntrigger: "always_on"\r\ndescription: \'Use tabs: always\'\r\n---\r\nLine one\r\nLine two\r\n', info).rule;
    assert.equal(r.trigger, 'always_on');
    assert.equal(r.description, 'Use tabs: always');
    assert.equal(r.text, 'Line one\r\nLine two');
    const g = rulesMod.parseRule('---\r\ntrigger: glob\r\nglobs: "*.py, *_test.py"\r\n---\r\nPEP 8', info).rule;
    assert.deepEqual(g.globs, ['*.py', '*_test.py']);
  });

  test('trigger spellings: always_on, "Always On", always-on and model decision are accepted; alwaysOn is not', () => {
    for (const t of ['always_on', 'Always On', 'always-on', 'ALWAYS_ON']) assert.equal(rulesMod.normalizeTrigger(t), 'always_on', t);
    assert.equal(rulesMod.normalizeTrigger('model decision'), 'model_decision');
    assert.equal(rulesMod.normalizeTrigger('alwaysOn'), null);
    assert.match(rulesMod.parseRule('---\ntrigger: alwaysOn\n---\nx', info).error, /unknown trigger "alwaysOn"/);
  });

  test('globs: comma list, [a, b] list, YAML block list and the singular "glob" key', () => {
    assert.deepEqual(rulesMod.parseRule('---\ntrigger: glob\nglobs: ["*.ts", \'src/**/*.tsx\']\n---\nx', info).rule.globs, ['*.ts', 'src/**/*.tsx']);
    assert.deepEqual(rulesMod.parseRule('---\ntrigger: glob\nglobs:\n  - "*.py"\n  - docs/*.md\n---\nx', info).rule.globs, ['*.py', 'docs/*.md']);
    assert.deepEqual(rulesMod.parseRule('---\ntrigger: glob\nglob: "*.go"\n---\nx', info).rule.globs, ['*.go']);
    assert.match(rulesMod.parseRule('---\ntrigger: glob\n---\nx', info).error, /needs globs/);
    assert.match(rulesMod.parseRule('---\ntrigger: model_decision\n---\nx', info).error, /needs a description/);
    // a folded description keeps working as before (skills use the same parser)
    assert.equal(parseFrontmatter('---\ndescription: >\n  one\n  two\n---\n').meta.description, 'one two');
  });

  test('rulesForFile: a name pattern matches at any depth, a path pattern from the project folder, braces work', () => {
    const rules = [
      { name: 'py', trigger: 'glob', globs: ['*.py'] },
      { name: 'web', trigger: 'glob', globs: ['web/**/*.{js,css}'] },
      { name: 'm', trigger: 'manual', globs: ['*.py'] },
    ];
    const names = (rel) => rulesMod.rulesForFile(rules, rel).map((r) => r.name);
    assert.deepEqual(names('src\\deep\\app.py'), ['py']);
    assert.deepEqual(names('web/js/a.js'), ['web']);
    assert.deepEqual(names('web/a.css'), ['web']);
    assert.deepEqual(names('lib/web/a.js'), []);
    assert.deepEqual(names('README.md'), []);
  });

  test('mentionedRules: @name and @name.md find rules that are not always on', () => {
    const rules = [{ name: 'Style', trigger: 'manual' }, { name: 'base', trigger: 'always_on' }, { name: 'db', trigger: 'model_decision' }];
    assert.deepEqual(rulesMod.mentionedRules(rules, 'follow @style, and @db.md please; @base @nothing a@style').map((x) => x.rule.name), ['Style', 'db']);
  });

  test('loadRules: .agents/rules and .agent/rules up to the repository root, then yours; nearer wins; problems are listed', async () => {
    const repo = newWs('repo-load');
    const ws = path.join(repo, 'pkg');
    put(path.join(ws, '.agents', 'rules', 'style.md'), '---\ntrigger: always_on\n---\nNear style');
    put(path.join(ws, '.agents', 'rules', 'notes.txt'), 'not markdown');
    put(path.join(ws, '.agent', 'rules', 'legacy.md'), '---\ntrigger: manual\n---\nLegacy');
    put(path.join(repo, '.agents', 'rules', 'style.md'), '---\ntrigger: always_on\n---\nFar style');
    put(path.join(repo, '.agents', 'rules', 'db.md'), '---\ntrigger: model_decision\ndescription: Database work\n---\nUse migrations');
    put(path.join(repo, '.agents', 'rules', 'broken.md'), 'no frontmatter');
    const userDir = path.join(TMP, 'user-rules-load');
    put(path.join(userDir, 'db.md'), '---\ntrigger: always_on\n---\nMine');
    put(path.join(userDir, 'mine.md'), '---\ntrigger: always_on\n---\nOnly mine');
    const { rules, errors } = await rulesMod.loadRules(new Backend({ kind: 'native' }), ws, { userDir });
    assert.deepEqual(rules.map((r) => [r.name, r.scope]).sort(), [['db', 'project'], ['legacy', 'project'], ['mine', 'user'], ['style', 'project']]);
    assert.equal(rules.find((r) => r.name === 'style').text, 'Near style');
    assert.equal(rules.find((r) => r.name === 'db').path, path.join(repo, '.agents', 'rules', 'db.md'));
    assert.deepEqual(errors, ['broken: no frontmatter with a trigger, so it is not loaded']);
  });

  test('rulesPrompt: always-on rules in full, model-decision rules as name, description and path; over the budget the largest becomes a pointer', () => {
    const rules = [
      { name: 'small', trigger: 'always_on', text: 'S'.repeat(10), path: 'a/small.md', description: '' },
      { name: 'big', trigger: 'always_on', text: 'B'.repeat(100), path: 'a/big.md', description: 'Big one' },
      { name: 'db', trigger: 'model_decision', text: 'secret body', path: 'a/db.md', description: 'Database work' },
      { name: 'g', trigger: 'glob', text: 'glob body', path: 'a/g.md', globs: ['*'] },
      { name: 'm', trigger: 'manual', text: 'manual body', path: 'a/m.md' },
    ];
    const full = rulesMod.rulesPrompt(rules);
    assert.match(full, /<rule name="small" path="a\/small\.md">\nSSSSSSSSSS\n<\/rule>/);
    assert.match(full, /- db: Database work \[a\/db\.md\]/);
    assert.ok(!/secret body|glob body|manual body/.test(full));
    const tight = rulesMod.rulesPrompt(rules, { budget: 50 });
    assert.ok(!tight.includes('BBBB'));
    assert.match(tight, /- big: Big one \[a\/big\.md\]/);
    assert.match(tight, /SSSSSSSSSS/);
    assert.equal(rulesMod.rulesPrompt([rules[3], rules[4]]), '');
  });
});

describe('rules in a session', () => {
  test('always-on rules are in the system prompt, model-decision rules are listed, glob and manual ones are not; AGENTS.md is unchanged', async () => {
    const ws = newWs();
    put(path.join(ws, 'AGENTS.md'), 'Agents file text');
    put(path.join(ws, '.agents', 'rules', 'tabs.md'), '---\ntrigger: always_on\n---\nIndent with tabs.');
    put(path.join(ws, '.agents', 'rules', 'db.md'), '---\ntrigger: model_decision\ndescription: Changing the database schema\n---\nWrite a migration.');
    put(path.join(ws, '.agents', 'rules', 'py.md'), '---\ntrigger: glob\nglobs: "*.py"\n---\nPython rule body.');
    put(path.join(ws, '.agents', 'rules', 'release.md'), '---\ntrigger: manual\n---\nRelease rule body.');
    const p = await make(ws);
    const n = requests.length;
    script = [reply('ok')];
    await send(p, 'hi');
    const sys = systemOf(bodies(n)[0]);
    assert.match(sys, /<instructions path="[^"]*AGENTS\.md">\nAgents file text\n<\/instructions>/);
    assert.match(sys, /# Rules[\s\S]*<rule name="tabs" path="[^"]*tabs\.md">\nIndent with tabs\.\n<\/rule>/);
    assert.match(sys, /- db: Changing the database schema \[[^\]]*db\.md\]/);
    assert.ok(!/Write a migration|Python rule body|Release rule body/.test(sys));
  });

  test('glob rule: added to the result of the first read of a matching file, once; other files get nothing', async () => {
    const ws = newWs();
    put(path.join(ws, '.agents', 'rules', 'py.md'), '---\ntrigger: glob\nglobs: "*.py"\n---\nPython rule body.');
    put(path.join(ws, 'src', 'app.py'), 'print(1)');
    put(path.join(ws, 'src', 'b.py'), 'print(2)');
    put(path.join(ws, 'notes.txt'), 'notes');
    const p = await make(ws);
    script = [calls({ id: 'r1', name: 'read', args: { path: 'notes.txt' } }), calls({ id: 'r2', name: 'read', args: { path: 'src/app.py' } }), calls({ id: 'r3', name: 'read', args: { path: 'src/b.py' } }), reply('done')];
    await send(p, 'look around');
    const [notes, app, b] = toolResults(p);
    assert.ok(!/Python rule body/.test(notes));
    assert.match(app, /\[Rules for this file; follow them\]\n<rule name="py" [^>]*trigger="glob" applies="\*\.py">\nPython rule body\.\n<\/rule>/);
    assert.ok(!/Python rule body/.test(b), 'shown once per session');
    assert.ok(p.events.some((e) => e.type === 'notice' && /Rule applied for src\/app\.py: py/.test(e.message)));
  });

  test('glob rule: a written file and an @-mentioned file trigger it too', async () => {
    const ws = newWs();
    put(path.join(ws, '.agents', 'rules', 'ts.md'), '---\ntrigger: glob\nglobs: ["*.ts"]\n---\nTS rule body.');
    put(path.join(ws, '.agents', 'rules', 'css.md'), '---\ntrigger: glob\nglobs: "*.css"\n---\nCSS rule body.');
    put(path.join(ws, 'a.css'), 'body{}');
    const p = await make(ws);
    script = [calls({ id: 'w1', name: 'write', args: { path: 'x.ts', content: 'let a = 1;' } }), reply('done')];
    await send(p, 'write it');
    assert.match(toolResults(p)[0], /TS rule body\./);
    const n = requests.length;
    script = [reply('ok')];
    await send(p, 'check @a.css');
    assert.match(JSON.stringify(bodies(n)[0].messages.at(-1)), /CSS rule body\./);
  });

  test('manual rule: only when you @-mention it by name', async () => {
    const ws = newWs();
    put(path.join(ws, '.agents', 'rules', 'release.md'), '---\ntrigger: manual\ndescription: Releases\n---\nRelease rule body.');
    const p = await make(ws);
    const n = requests.length;
    script = [reply('a'), reply('b')];
    await send(p, 'how do we release?');
    assert.ok(!JSON.stringify(bodies(n)[0]).includes('Release rule body'));
    await send(p, 'follow @release now');
    assert.match(JSON.stringify(bodies(n)[1].messages.at(-1)), /Release rule body\./);
    assert.ok(p.messages.findLast((m) => m.role === 'user').attachments.some((a) => /release\.md$/.test(a.path)));
  });

  test('model-decision rule: the agent reads it with read, without the outside-the-project question, even from your own rules folder', async () => {
    const ws = newWs();
    const mine = put(path.join(rulesMod.userRulesDir(), 'commits.md'), '---\ntrigger: model_decision\ndescription: Writing commit messages\n---\nUse the imperative mood.');
    try {
      const p = await make(ws, makeConfig({ data: { approvals: 'ask', providers: {}, defaultModel: 'anthropic/claude-test' } }));
      p._askUser = async () => assert.fail('must not ask to read a listed rule');
      const n = requests.length;
      script = [calls({ id: 'r1', name: 'read', args: { path: mine } }), reply('done')];
      await send(p, 'commit this');
      assert.match(systemOf(bodies(n)[0]), new RegExp(`- commits: Writing commit messages \\[${mine.replace(/[\\.]/g, '\\$&')}\\]`));
      assert.match(toolResults(p)[0], /Use the imperative mood\./);
      // any other file outside the project still asks
      assert.equal(p._outside({ name: 'read' }, { path: path.join(TMP, 'elsewhere.txt') }), true);
      assert.equal(p._outside({ name: 'read' }, { path: mine }), false);
    } finally {
      fs.rmSync(mine, { force: true });
    }
  });

  test('/memory lists the rules and the files that are not loaded', async () => {
    const ws = newWs();
    put(path.join(ws, '.agents', 'rules', 'py.md'), '---\ntrigger: glob\nglobs: "*.py"\n---\nx');
    put(path.join(ws, '.agents', 'rules', 'bad.md'), '---\ntrigger: sometimes\n---\nx');
    const out = [];
    await runSlash({ workspace: ws, backend: { hostPath: (p) => p, keyPath: (p) => p }, _out: (t) => out.push(t) }, '/memory');
    assert.match(out[0], /- \*\*py\*\*: for files \*\.py/);
    assert.match(out[0], /problem: bad: unknown trigger "sometimes"/);
  });
});

// =====================================================================================================
describe('hook events and JSON decisions', () => {
  const nodeCmd = (file) => `"${process.execPath}" "${file}"`;
  const hooksFile = hooks.userHooksPath();
  const writeHooks = (obj) => put(hooksFile, JSON.stringify({ hooks: obj }));
  after(() => fs.rmSync(hooksFile, { force: true }));
  let seq = 0;
  /** A hook script: appends its stdin JSON to `log` (one line each), then runs `body` (with `j` the parsed input). */
  const hookJs = (body, log = path.join(TMP, `log${seq}.jsonl`)) => ({ file: put(path.join(TMP, `hook${seq++}.js`), `let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{require('fs').appendFileSync(${JSON.stringify(log)},d.replace(/\\n/g,' ')+'\\n');const j=JSON.parse(d);${body}})`), log });
  const lines = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  test('parseHookOutput: decisions, reasons and context in both shapes; plain text is not a decision', () => {
    const P = hooks.parseHookOutput;
    assert.deepEqual(P('{"decision":"block","reason":"no"}'), { decision: 'block', reason: 'no', context: '' });
    assert.equal(P('{"decision":"deny"}').decision, 'block');
    assert.equal(P('{"decision":"allow"}').decision, 'allow');
    assert.equal(P('{"decision":"Continue"}').decision, 'continue');
    assert.equal(P('{"terminationBehavior":"terminate"}').decision, 'block');
    assert.equal(P('{"terminationBehavior":"force_continue"}').decision, 'continue');
    assert.equal(P('{"additionalContext":"ctx"}').context, 'ctx');
    assert.equal(P('{"hookSpecificOutput":{"additionalContext":"cc"}}').context, 'cc');
    assert.equal(P('{"injectSteps":[{"systemMessage":"s"},{"userMessage":"u"},{"errorMessage":"e"}]}').context, 's\nu');
    assert.equal(P('{}').decision, null);
    assert.equal(P('all good'), null);
    assert.equal(P('{broken'), null);
    assert.equal(P('[1]'), null);
  });

  test('hooks files: the new events are accepted, entries may hold a "hooks" list, other types are reported', () => {
    const f = put(path.join(TMP, 'events.json'), JSON.stringify({ hooks: {
      SessionStart: [{ command: 's' }],
      PreInvocation: [{ command: 'a' }],
      PostInvocation: [{ hooks: [{ type: 'command', command: 'b', timeout: 3 }, { type: 'prompt', command: 'x' }] }],
      PreToolUse: [{ matcher: 'bash', hooks: [{ command: 'c' }] }],
    } }));
    const r = hooks.readHooksFile(f);
    assert.deepEqual(hooks.listHooks(r).map((x) => [x.event, x.matcher, x.command, x.timeout]), [['SessionStart', '', 's', 10], ['PreInvocation', '', 'a', 10], ['PostInvocation', '', 'b', 3], ['PreToolUse', 'bash', 'c', 10]]);
    assert.deepEqual(r.errors, ['A PostInvocation hook has type "prompt"; only "command" is supported']);
    assert.ok(hooks.HOOK_EVENTS.includes('SessionStart') && hooks.HOOK_EVENTS.includes('PreInvocation') && hooks.HOOK_EVENTS.includes('PostInvocation'));
  });

  test('SessionStart: once per session, when its first message is accepted; its context reaches the model; it cannot block', async () => {
    const ctx = hookJs(`console.log(JSON.stringify({additionalContext:'Today is release day.'}))`);
    const blocker = hookJs(`console.log(JSON.stringify({decision:'block',reason:'nope'}))`);
    writeHooks({ SessionStart: [{ command: nodeCmd(ctx.file) }, { command: nodeCmd(blocker.file) }] });
    const p = await make(newWs());
    const n = requests.length;
    script = [reply('a'), reply('b')];
    await send(p, 'first');
    await send(p, 'second');
    const runs = lines(ctx.log);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].event, 'SessionStart');
    assert.equal(runs[0].source, 'new');
    assert.equal(runs[0].sessionId, p.sessionId);
    assert.match(JSON.stringify(bodies(n)[0].messages), /\[SessionStart hook\] Today is release day\./);
    assert.equal(bodies(n).length, 2, 'the block was ignored: both messages reached the model');
    assert.ok(p.events.some((e) => e.type === 'notice' && /SessionStart hook cannot block/.test(e.message)));
  });

  test('UserPromptSubmit: JSON block stops the message, exit 2 still does, additionalContext follows the message', async () => {
    const gate = hookJs(`if(j.input.prompt.includes('json'))console.log(JSON.stringify({decision:'block',reason:'json says no'}));else if(j.input.prompt.includes('exit'))(console.error('exit says no'),process.exit(2));else console.log(JSON.stringify({decision:'allow',additionalContext:'Branch is main.'}))`);
    writeHooks({ UserPromptSubmit: [{ command: nodeCmd(gate.file) }] });
    const p = await make(newWs());
    const n = requests.length;
    await send(p, 'json please');
    await send(p, 'exit please');
    assert.equal(requests.length, n);
    assert.ok(p.events.some((e) => e.type === 'notice' && /A hook blocked this message: json says no/.test(e.message)));
    assert.ok(p.events.some((e) => e.type === 'notice' && /A hook blocked this message: exit says no/.test(e.message)));
    script = [reply('ok')];
    await send(p, 'hello');
    const msgs = bodies(n)[0].messages;
    assert.match(JSON.stringify(msgs.at(-1)), /\[UserPromptSubmit hook\] Branch is main\./);
    assert.match(JSON.stringify(msgs.at(-2)), /hello/);
  });

  test('PreInvocation and PostInvocation: once per model call, in order, with the invocation number and the reply', async () => {
    const order = path.join(TMP, 'order.jsonl');
    const pre = hookJs('', order);
    const post = hookJs('', order);
    writeHooks({ PreInvocation: [{ command: nodeCmd(pre.file) }], PostInvocation: [{ command: nodeCmd(post.file) }] });
    const ws = newWs();
    const p = await make(ws);
    script = [calls({ id: 'g1', name: 'glob', args: { pattern: '*.none' } }), reply('done')];
    await send(p, 'go');
    const seen = lines(order).map((j) => [j.event, j.invocationNum]);
    assert.deepEqual(seen, [['PreInvocation', 1], ['PostInvocation', 1], ['PreInvocation', 2], ['PostInvocation', 2]]);
    const posts = lines(order).filter((j) => j.event === 'PostInvocation');
    assert.deepEqual(posts[0].toolCalls, [{ name: 'glob', args: { pattern: '*.none' } }]);
    assert.equal(posts[1].text, 'done');
    assert.equal(posts[1].stopReason, 'stop');
  });

  test('PreInvocation: a block stops the run before the model is called; context is added before the call', async () => {
    const pre = hookJs(`if(j.invocationNum===1)console.log(JSON.stringify({injectSteps:[{systemMessage:'Remember the style guide.'}]}));else(console.error('budget used up'),process.exit(2))`);
    writeHooks({ PreInvocation: [{ command: nodeCmd(pre.file) }] });
    const p = await make(newWs());
    const n = requests.length;
    script = [calls({ id: 'g1', name: 'glob', args: { pattern: '*.none' } }), reply('never')];
    const end = await send(p, 'go');
    assert.equal(requests.length - n, 1, 'the second model call never happened');
    assert.match(JSON.stringify(bodies(n)[0].messages.at(-1)), /\[PreInvocation hook\] Remember the style guide\./);
    assert.equal(end.stopReason, 'hook');
    assert.ok(p.events.some((e) => e.type === 'notice' && /A PreInvocation hook stopped the agent: budget used up/.test(e.message)));
    script.length = 0;
  });

  test('PostInvocation: a block ends the run and the reply\'s tool calls do not run; the next request is still valid', async () => {
    const post = hookJs(`if(j.toolCalls.some(c=>c.name==='write'))console.log(JSON.stringify({decision:'block',reason:'no writes today'}))`);
    writeHooks({ PostInvocation: [{ command: nodeCmd(post.file) }] });
    const ws = newWs();
    const p = await make(ws);
    const n = requests.length;
    script = [calls({ id: 'w1', name: 'write', args: { path: 'x.txt', content: 'x' } })];
    const end = await send(p, 'write');
    assert.equal(end.stopReason, 'hook');
    assert.ok(!fs.existsSync(path.join(ws, 'x.txt')));
    assert.match(toolResults(p)[0], /Not run: a PostInvocation hook stopped the agent: no writes today/);
    script = [reply('ok')];
    await send(p, 'and now?');
    const msgs = bodies(n)[1].messages;
    assert.ok(msgs.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'w1')));
  });

  test('PostInvocation context reaches the model at its next call, after the tool results', async () => {
    const post = hookJs(`if(j.invocationNum===1)console.log(JSON.stringify({additionalContext:'Tests are slow; run one file.'}))`);
    writeHooks({ PostInvocation: [{ command: nodeCmd(post.file) }] });
    const p = await make(newWs());
    const n = requests.length;
    script = [calls({ id: 'g1', name: 'glob', args: { pattern: '*.none' } }), reply('done')];
    await send(p, 'go');
    const msgs = bodies(n)[1].messages;
    assert.match(JSON.stringify(msgs.at(-1)), /\[PostInvocation hook\] Tests are slow; run one file\./);
    assert.ok(JSON.stringify(msgs.at(-2)).includes('tool_result'));
  });

  test('PreToolUse: "allow" lets the call run, "deny" blocks it, exit 2 still blocks (existing configs keep working)', async () => {
    const pre = hookJs(`const p=j.input.path||'';if(p.includes('deny'))console.log(JSON.stringify({decision:'deny',reason:'denied by policy'}));else if(p.includes('exit'))(console.error('exit two'),process.exit(2));else console.log(JSON.stringify({decision:'allow'}))`);
    writeHooks({ PreToolUse: [{ matcher: 'write', command: nodeCmd(pre.file) }] });
    const ws = newWs();
    const p = await make(ws);
    script = [calls({ id: 'a', name: 'write', args: { path: 'ok.txt', content: '1' } }, { id: 'b', name: 'write', args: { path: 'deny.txt', content: '2' } }, { id: 'c', name: 'write', args: { path: 'exit.txt', content: '3' } }), reply('done')];
    await send(p, 'write three');
    const [a, b, c] = toolResults(p);
    assert.ok(fs.existsSync(path.join(ws, 'ok.txt')));
    assert.doesNotMatch(a, /Blocked/);
    assert.match(b, /Blocked by a hook: denied by policy/);
    assert.match(c, /Blocked by a hook: exit two/);
    assert.ok(!fs.existsSync(path.join(ws, 'deny.txt')) && !fs.existsSync(path.join(ws, 'exit.txt')));
  });

  test('PostToolUse additionalContext becomes feedback; Stop {"decision":"continue"} asks for one more step', async () => {
    const post = hookJs(`console.log(JSON.stringify({additionalContext:'lint clean'}))`);
    const stop = hookJs(`console.log(JSON.stringify({decision:'continue',reason:'summarize first'}))`);
    writeHooks({ PostToolUse: [{ matcher: 'glob', command: nodeCmd(post.file) }], Stop: [{ command: nodeCmd(stop.file) }] });
    const p = await make(newWs());
    const n = requests.length;
    script = [calls({ id: 'g1', name: 'glob', args: { pattern: '*.none' } }), reply('first'), reply('second')];
    await send(p, 'go');
    assert.match(toolResults(p)[0], /\[Hook feedback\] lint clean/);
    assert.equal(requests.length - n, 3);
    assert.match(JSON.stringify(bodies(n)[2].messages.at(-1)), /A Stop hook asks you to continue: summarize first/);
    assert.equal(lines(stop.log).length, 1, 'once per run');
  });
});
