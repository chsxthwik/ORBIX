// Regression tests for the performance and security work: backend probing and caching, log size cap, session
// storage (held append handles, cached listing), DPAPI key cache, tool output limits, web_fetch address checks,
// MCP trust text, OpenRouter callback checks, git path checks and the slash-command module.
// No network and no provider keys; ORBIX_DATA points at a temp folder.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-hard-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA;
fs.mkdirSync(DATA, { recursive: true });

const { Backend, parseProbe, parseDistroList } = await import('../src/backend.mjs');
const util = await import('../src/util.mjs');
const store = await import('../src/engine/store.mjs');
const { createTools, isForeignShare } = await import('../src/engine/tools.mjs');
const fsapi = await import('../src/fsapi.mjs');
const { isPrivateAddress } = await import('../src/engine/webfetch.mjs');
const { userMentionsHost } = await import('../src/engine/proc.mjs');
const { describeServer, McpManager } = await import('../src/engine/mcp.mjs');
const oauth = await import('../src/engine/oauth.mjs');
const gitapi = await import('../src/gitapi.mjs');
const { runSlash, HELP } = await import('../src/engine/slash.mjs');
const { readMentions } = await import('../src/engine/context.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('backend probing', () => {
  test('parseProbe reads marked values and ignores login-shell banners', () => {
    const out = 'Welcome to Linux!\nORBIX_HOME=/home/u\nsome motd line\nORBIX_OMP=/home/u/.local/bin/omp\nORBIX_VER=omp/18.15.0\n';
    assert.deepEqual(parseProbe(out), { home: '/home/u', omp: '/home/u/.local/bin/omp', version: 'omp/18.15.0' });
  });
  test('parseProbe: no omp, and a non-absolute omp path is not trusted', () => {
    assert.deepEqual(parseProbe('ORBIX_HOME=/root\nORBIX_OMP=\n'), { home: '/root', omp: null, version: null });
    assert.equal(parseProbe('ORBIX_HOME=/root\nORBIX_OMP=omp: not found\n').omp, null);
    assert.deepEqual(parseProbe(''), { home: null, omp: null, version: null });
  });
  test('parseDistroList: names, default, Docker skipped, translated STATE column with spaces', () => {
    const en = '  NAME                   STATE           VERSION\r\n* Debian             Running         2\r\n  Ubuntu-22.04           Stopped         2\r\n  docker-desktop         Stopped         2\r\n';
    assert.deepEqual(parseDistroList(en), { distros: ['Debian', 'Ubuntu-22.04'], defaultDistro: 'Debian' });
    const de = '  NAME      STATUS            VERSION\n  Debian    Wird ausgeführt   2\n* Ubuntu    Beendet           1\n';
    assert.deepEqual(parseDistroList(de), { distros: ['Debian', 'Ubuntu'], defaultDistro: 'Ubuntu' });
    assert.deepEqual(parseDistroList(''), { distros: [], defaultDistro: '' });
  });
  test('update() keeps cached lookups when nothing changed and drops them when the config changes', async () => {
    const b = new Backend({ kind: 'native', distro: '', ompPath: 'C:\\tools\\omp.exe' });
    b._probe = { home: 'C:\\Users\\u', omp: 'C:\\tools\\omp.exe', version: 'omp/1' };
    b._probeAt = Date.now();
    b.update({ kind: 'native', distro: '', ompPath: 'C:\\tools\\omp.exe' });
    assert.equal(await b.resolveOmp(), 'C:\\tools\\omp.exe');
    assert.equal(await b.version(), 'omp/1');
    b.update({ kind: 'wsl', distro: 'Ubuntu', ompPath: '' });
    assert.equal(b._probe, null);
    b.forget();
    assert.equal(b._home, null);
  });
  test('concurrent probe() calls share one lookup', async () => {
    const b = new Backend({ kind: 'native' });
    let runs = 0;
    b._runProbe = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 20));
      return { home: 'H', omp: 'X', version: 'v' };
    };
    const [a, c] = await Promise.all([b.probe(), b.probe()]);
    assert.equal(runs, 1);
    assert.equal(a, c);
    await b.probe();
    assert.equal(runs, 1, 'a found omp is cached');
  });
  test('a missing omp is looked up again only after 30 s', async () => {
    const b = new Backend({ kind: 'native' });
    let runs = 0;
    b._runProbe = async () => (runs++, { home: 'H', omp: null, version: null });
    await b.probe();
    await b.probe();
    assert.equal(runs, 1);
    b._probeAt -= 31000;
    await b.probe();
    assert.equal(runs, 2);
  });
});

describe('util', () => {
  test('pool keeps order, limits concurrency and turns failures into null', async () => {
    let live = 0;
    let peak = 0;
    const out = await util.pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (x === 3) throw new Error('bad');
      return x * 10;
    });
    assert.deepEqual(out, [10, 20, null, 40, 50, 60]);
    assert.equal(peak, 2);
  });
  test('textOf joins text parts with the given separator', () => {
    assert.equal(util.textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a b');
    assert.equal(util.textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], '\n'), 'a\nb');
    assert.equal(util.textOf('plain'), 'plain');
    assert.equal(util.textOf(null), '');
  });
  test('the server log never grows past 1 MiB: it rolls over to server.log.1', () => {
    const file = path.join(TMP, 'logs', 'server.log');
    util.initLog(file);
    const chunk = 'x'.repeat(10000);
    for (let i = 0; i < 160; i++) util.log(chunk);
    assert.ok(fs.statSync(file).size <= 1024 * 1024);
    assert.ok(fs.existsSync(`${file}.1`));
    assert.ok(fs.statSync(`${file}.1`).size <= 1024 * 1024);
  });
});

describe('agent session storage', () => {
  test('appends through held handles are all saved, also past the open-handle limit', () => {
    const sessions = [];
    for (let i = 0; i < 40; i++) sessions.push(store.createSession({ cwd: 'C:\\p', keyPath: `c:\\p${i}`, model: 'm', provider: 'x' }));
    for (let round = 0; round < 3; round++) for (const s of sessions) store.appendEntry(s.file, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `r${round}` }] } });
    for (const s of sessions) {
      const l = store.loadSession(s.file);
      assert.equal(l.header.id, s.id);
      assert.deepEqual(l.messages.map((m) => m.content[0].text), ['r0', 'r1', 'r2']);
      store.closeSession(s.file);
    }
  });
  test('a session with an open handle can be deleted', async () => {
    const s = store.createSession({ cwd: 'C:\\q', keyPath: 'c:\\q', model: '', provider: '' });
    store.appendEntry(s.file, { type: 'title', title: 'x' });
    assert.equal(await store.deleteAgentSessions([s.file]), 1);
    assert.equal(fs.existsSync(s.file), false);
  });
  test('the listing re-reads only changed files and forgets deleted ones', async () => {
    const b = new Backend({ kind: 'native' });
    const s = store.createSession({ cwd: 'C:\\list', keyPath: 'c:\\list', model: '', provider: '' });
    store.appendEntry(s.file, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'first task here' }] } });
    store.closeSession(s.file);
    let row = (await store.listAgentSessions(b)).find((r) => r.id === s.id);
    assert.equal(row.title, 'First task here');
    store.appendEntry(s.file, { type: 'title', title: 'Renamed' });
    store.closeSession(s.file);
    row = (await store.listAgentSessions(b)).find((r) => r.id === s.id);
    assert.equal(row.title, 'Renamed');
    await store.deleteAgentSessions([s.file]);
    assert.equal((await store.listAgentSessions(b)).some((r) => r.id === s.id), false);
  });
  test('parseAgentHead ignores a cut last line', () => {
    const text = `${JSON.stringify({ type: 'session', id: 'b1', cwd: '/x' })}\n${JSON.stringify({ type: 'title', title: 'T' })}\n{"type":"mess`;
    const h = store.parseAgentHead(text);
    assert.equal(h.header.id, 'b1');
    assert.equal(h.title, 'T');
  });
  test('isAgentSessionPath only accepts files inside data/sessions', () => {
    assert.equal(store.isAgentSessionPath(path.join(DATA, 'sessions', 'a', 'b.jsonl')), true);
    assert.equal(store.isAgentSessionPath(path.join(DATA, 'sessions-x', 'b.jsonl')), false);
    assert.equal(store.isAgentSessionPath(path.join(DATA, 'sessions', '..', 'engine.json')), false);
  });
});

describe('API key cache', { skip: process.platform !== 'win32' && 'DPAPI is Windows-only' }, () => {
  test('a saved key is decrypted once per run, and forgotten when the provider is cleared', async () => {
    const cfg = new store.EngineConfig(path.join(TMP, 'keys'));
    await cfg.setProvider('openai', { key: 'sk-test-cache-1', models: 3 });
    assert.equal(await cfg.getKey('openai'), 'sk-test-cache-1');
    const t = performance.now();
    assert.equal(await cfg.getKey('openai'), 'sk-test-cache-1');
    assert.ok(performance.now() - t < 50, 'no PowerShell call for a cached key');
    const fresh = new store.EngineConfig(path.join(TMP, 'keys'));
    assert.equal(await fresh.getKey('openai'), 'sk-test-cache-1', 'a new run decrypts from disk');
    const stored = cfg.data.providers.openai.key;
    cfg.clearProvider('openai');
    assert.equal(cfg.plain.has(stored), false);
    assert.equal(await cfg.getKey('openai'), null);
  });
});

describe('network paths', () => {
  test('the agent never opens a share outside its own project share (Windows would send the user\'s credentials)', async () => {
    assert.equal(isForeignShare('\\\\evil.example\\x\\a.txt', 'C:\\work'), true);
    assert.equal(isForeignShare('//evil/x/a', 'C:\\work'), true);
    assert.equal(isForeignShare('\\\\nas\\other\\a', '\\\\nas\\proj'), true);
    assert.equal(isForeignShare('\\\\NAS\\Proj\\src\\a', '\\\\nas\\proj\\'), false);
    assert.equal(isForeignShare('\\\\wsl.localhost\\Ubuntu\\home\\u', 'C:\\work'), false);
    assert.equal(isForeignShare('\\\\wsl$\\Ubuntu\\home\\u', 'C:\\work'), false);
    assert.equal(isForeignShare('C:\\x', 'C:\\work'), false);
    const tools = createTools({ backend: new Backend({ kind: 'native' }), cwd: TMP, getSignal: () => null });
    for (const name of ['read', 'glob', 'grep', 'write']) {
      const r = await tools.run(name, { path: '\\\\attacker.invalid\\share\\x.txt', pattern: 'x', content: 'x' });
      assert.equal(r.isError, true, name);
      assert.match(r.text, /Network paths are not opened by the agent/, name);
    }
  });
  test('Explorer is only asked to show paths that exist', async () => {
    await assert.rejects(fsapi.reveal(new Backend({ kind: 'native' }), path.join(TMP, 'does-not-exist.txt')), (e) => e.status === 404);
  });
});

describe('read tool output limits', () => {
  const dir = path.join(TMP, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const tools = createTools({ backend: new Backend({ kind: 'native' }), cwd: dir, getSignal: () => null });
  test('a very long line is cut at 2000 characters and says so', async () => {
    fs.writeFileSync(path.join(dir, 'min.js'), 'a'.repeat(50000) + '\nshort\n');
    const r = await tools.run('read', { path: 'min.js' });
    const [first] = r.text.split('\n');
    assert.ok(first.length < 2100);
    assert.match(first, /\[line cut: 50000 characters\]/);
    assert.match(r.text, /1 long line cut at 2000 characters/);
    assert.match(r.text, /2\tshort/);
  });
  test('the whole read is capped and tells where to continue', async () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 2000 }, (_, i) => `${i} ${'y'.repeat(1500)}`).join('\n'));
    const r = await tools.run('read', { path: 'big.txt' });
    assert.ok(r.text.length < 205000);
    assert.match(r.text, /output limit of 200000 characters\); pass offset=\d+ to continue/);
  });
});

describe('web_fetch address checks', () => {
  test('IPv4 carried in 6to4 and Teredo addresses is judged', () => {
    assert.equal(isPrivateAddress('2002:7f00:1::'), true); // 127.0.0.1
    assert.equal(isPrivateAddress('2002:a9fe:a9fe::1'), true); // 169.254.169.254
    assert.equal(isPrivateAddress('2002:808:808::'), false); // 8.8.8.8
    assert.equal(isPrivateAddress('2001:0:4136:e378:8000:63bf:80ff:fffe'), true); // Teredo -> 127.0.0.1
    assert.equal(isPrivateAddress('2001:0:4136:e378:8000:63bf:f7f7:f7f7'), false); // Teredo -> 8.8.8.8
    assert.equal(isPrivateAddress('2606:4700::1111'), false);
  });
  const msg = (text, attribution = 'user') => ({ role: 'user', attribution, content: [{ type: 'text', text }] });
  test('a private host counts as asked for only when the user typed it as a whole word', () => {
    assert.equal(userMentionsHost([msg('check http://localhost:3000/api')], 'localhost'), true);
    assert.equal(userMentionsHost([msg('open 10.0.0.15 please')], '10.0.0.1'), false);
    assert.equal(userMentionsHost([msg('open 10.0.0.1.')], '10.0.0.1'), true);
    assert.equal(userMentionsHost([msg('my-localhost-box')], 'localhost'), false);
    assert.equal(userMentionsHost([msg('look at [::1]:8080', 'steer')], '::1'), true);
  });
  test('text from a skill or command file does not count as the user asking', () => {
    assert.equal(userMentionsHost([msg('fetch http://169.254.169.254/latest', 'command')], '169.254.169.254'), false);
    assert.equal(userMentionsHost([{ role: 'toolResult', content: [{ type: 'text', text: '169.254.169.254' }] }], '169.254.169.254'), false);
  });
});

describe('MCP project trust text', () => {
  test('a long command shows its end too, so padding cannot hide what runs', () => {
    const cfg = { command: 'node', args: ['server.js', ...Array(200).fill('--pad'), '--evil-tail'] };
    const t = describeServer(cfg);
    assert.match(t, /^node server\.js/);
    assert.match(t, /--evil-tail$/);
    assert.match(t, /characters not shown/);
  });
  test('environment values show, except secret-looking ones', () => {
    const t = describeServer({ command: 'npx', args: ['x'], env: { NODE_OPTIONS: '--require ./a.js', API_TOKEN: 'abc123' } });
    assert.match(t, /NODE_OPTIONS=--require \.\/a\.js/);
    assert.match(t, /API_TOKEN=<6 characters>/);
    assert.doesNotMatch(t, /abc123/);
  });
  test('arguments with spaces are quoted', () => {
    assert.equal(describeServer({ command: 'run', args: ['a b', ''] }), 'run "a b" ""');
  });
});

describe('OpenRouter sign-in callback', () => {
  const fakeRes = () => {
    const r = { status: 0, headers: null, body: '' };
    r.writeHead = (s, h) => ((r.status = s), (r.headers = h));
    r.end = (b) => (r.body = String(b || ''));
    return r;
  };
  const url = (p) => new URL(p, 'http://localhost:1');
  test('an unknown or malformed state is refused', async () => {
    for (const s of ['nope', 'x'.repeat(32), '../../etc', '']) {
      const res = fakeRes();
      await oauth.handleCallback(url(`${oauth.CALLBACK_PATH}/${encodeURIComponent(s)}?code=abc`), res, {});
      assert.equal(res.status, 400, s);
      assert.match(res.headers['content-security-policy'], /default-src 'none'/);
    }
  });
  test('a malformed code is refused without calling OpenRouter, and the state is used up', async () => {
    const { state } = oauth.startOpenRouter({ port: 1 });
    const res = fakeRes();
    await oauth.handleCallback(url(`${oauth.CALLBACK_PATH}/${state}?code=${encodeURIComponent('<script>')}`), res, {});
    assert.equal(res.status, 400);
    assert.equal(oauth.oauthStatus(state).status, 'error');
    const again = fakeRes();
    await oauth.handleCallback(url(`${oauth.CALLBACK_PATH}/${state}?code=abc`), again, {});
    assert.equal(again.status, 400, 'one-time');
  });
  test('the sign-in URL is OpenRouter\'s own page with a PKCE S256 challenge', () => {
    const { url: u, state } = oauth.startOpenRouter({ port: 4321 });
    assert.equal(oauth.isOpenRouterAuthUrl(u), true);
    const x = new URL(u);
    assert.equal(x.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(x.searchParams.get('callback_url'), `http://localhost:4321${oauth.CALLBACK_PATH}/${state}`);
    oauth.cancelOAuth(state);
  });
});

describe('git views', () => {
  test('an untracked-file diff cannot read outside the project folder', async () => {
    const ws = path.join(TMP, 'repo');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'new.txt'), 'hello\n');
    fs.writeFileSync(path.join(TMP, 'outside.txt'), 'secret\n');
    const b = new Backend({ kind: 'native' });
    const ok = await gitapi.diff(b, ws, 'new.txt', { untracked: true });
    assert.match(ok.text, /\+hello/);
    for (const f of ['../outside.txt', '..\\outside.txt', path.join(TMP, 'outside.txt')]) {
      await assert.rejects(gitapi.diff(b, ws, f, { untracked: true }), /outside the project folder/, f);
    }
  });
});

describe('slash commands', () => {
  const fakeAgent = () => {
    const out = [];
    return { out, _out: (t) => out.push(t), streaming: false, backend: new Backend({ kind: 'native' }), workspace: path.join(TMP, 'proj'), _skills: async () => [] };
  };
  test('/help prints the help text; a path like /etc/hosts is not a command', async () => {
    const a = fakeAgent();
    assert.equal(await runSlash(a, '/help'), true);
    assert.equal(a.out[0], HELP);
    assert.equal(await runSlash(a, '/etc/hosts what is this'), false);
  });
  test('an unknown command answers with a hint instead of reaching the model', async () => {
    const a = fakeAgent();
    assert.equal(await runSlash(a, '/frobnicate'), true);
    assert.match(a.out[0], /Unknown command \/frobnicate/);
  });
  test('/undo while the agent works asks to wait', async () => {
    const a = { ...fakeAgent(), streaming: true };
    assert.equal(await runSlash(a, '/undo'), true);
    assert.match(a.out[0], /Wait for the agent to finish/);
  });
});

describe('@ mentions', () => {
  test('attaches files and folder listings; unknown paths and e-mail addresses are left alone', async () => {
    const ws = path.join(TMP, 'm');
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'AAA');
    const got = await readMentions(new Backend({ kind: 'native' }), ws, 'see @a.txt and @sub, not @missing.md or me@example.com');
    assert.deepEqual(got.map((g) => g.path), ['a.txt', 'sub']);
    assert.equal(got[0].text, 'AAA');
    assert.match(got[1].text, /folder listing/);
  });
});

describe('MCP stdio limits', () => {
  test('a server that streams an endless line is stopped instead of filling memory', async () => {
    const script = path.join(TMP, 'flood.mjs');
    fs.writeFileSync(script, "const c = 'x'.repeat(1 << 20);\n(function w() { while (process.stdout.write(c)); process.stdout.once('drain', w); })();\n");
    fs.writeFileSync(path.join(DATA, 'mcp.json'), JSON.stringify({ mcpServers: { flood: { command: process.execPath, args: [script] } } }));
    const notes = [];
    const m = new McpManager({ backend: new Backend({ kind: 'native' }), workspace: TMP, hostRoot: TMP, ask: async () => null, notice: (l, msg) => notes.push(msg) });
    const t0 = Date.now();
    await m.ensureStarted();
    await m.stopAll();
    assert.ok(Date.now() - t0 < 20000, 'start must fail fast');
    assert.match(notes.join('\n'), /could not start/);
  });
  test('a server that exits mid-call rejects the in-flight call cleanly (no hang)', async () => {
    const script = path.join(TMP, 'diemid.mjs');
    fs.writeFileSync(
      script,
      `import rl from 'node:readline';
const r = rl.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
r.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc:'2.0', id:m.id, result:{ protocolVersion:'2025-06-18', capabilities:{}, serverInfo:{ name:'die', version:'1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc:'2.0', id:m.id, result:{ tools:[{ name:'t', description:'d', inputSchema:{ type:'object', properties:{} } }] } });
  else if (m.method === 'tools/call') process.exit(1); });
`,
    );
    fs.writeFileSync(path.join(DATA, 'mcp.json'), JSON.stringify({ mcpServers: { die: { command: process.execPath, args: [script] } } }));
    const m = new McpManager({ backend: new Backend({ kind: 'native' }), workspace: TMP, hostRoot: TMP, ask: async () => null, notice: () => {} });
    await m.ensureStarted();
    const t0 = Date.now();
    const r = await m.call('mcp__die__t', {});
    assert.equal(r.isError, true);
    assert.ok(Date.now() - t0 < 20000, 'must not hang on the dead call');
    await m.stopAll();
  });
});

describe('path boundary hardening (backend / files)', () => {
  const cwd = 'C:\\work';
  test('agent tools treat extended-length and device UNC paths as foreign and refuse them', () => {
    for (const p of ['\\\\?\\UNC\\evil\\share\\x', '\\\\.\\C:\\Windows\\x', '\\\\.\\PhysicalDrive0', '\\\\?\\C:\\secret']) {
      assert.equal(isForeignShare(p, cwd), true, p);
    }
    // WSL's own shares and local paths stay allowed.
    assert.equal(isForeignShare('\\\\wsl.localhost\\Ubuntu\\home\\u', cwd), false);
    assert.equal(isForeignShare('C:\\work\\sub\\a.txt', cwd), false);
  });
  test('read/write refuse an extended-length UNC path rather than opening a network share', async () => {
    const tools = createTools({ backend: new Backend({ kind: 'native' }), cwd: TMP, getSignal: () => null });
    for (const name of ['read', 'write']) {
      const r = await tools.run(name, { path: '\\\\?\\UNC\\attacker.invalid\\share\\x.txt', content: 'x' });
      assert.equal(r.isError, true, name);
      assert.match(r.text, /Network paths are not opened by the agent/, name);
    }
  });
  test('the git panel refuses paths that leave the project (.., absolute, drive, backslash ..)', async () => {
    const b = new Backend({ kind: 'native' });
    for (const bad of ['../etc/passwd', '..\\etc\\passwd', '/etc/passwd', 'C:\\Windows\\x', 'a\0b']) {
      await assert.rejects(gitapi.stage(b, TMP, [bad]), (e) => e.status === 400, bad);
    }
  });
});

describe('reserved device names are not read as files', { skip: process.platform !== 'win32' && 'Windows device names only' }, () => {
  test('tools.read and fsapi.readFile refuse CON/NUL rather than blocking on the device', async () => {
    const dir = path.join(TMP, 'devdir');
    fs.mkdirSync(dir, { recursive: true });
    const tools = createTools({ backend: new Backend({ kind: 'native' }), cwd: dir, getSignal: () => null });
    for (const name of ['CON', 'NUL', 'CON.txt', 'LPT1']) {
      const r = await tools.run('read', { path: name });
      assert.equal(r.isError, true, name);
    }
    for (const name of ['CON', 'NUL']) {
      await assert.rejects(fsapi.readFile(new Backend({ kind: 'native' }), path.join(dir, name)), (e) => e.status === 404 || e.status === 400, name);
    }
  });
});

describe('links opened in the browser', () => {
  test('safeLink keeps http(s) only and percent-encodes quotes and spaces', () => {
    assert.equal(util.safeLink('https://example.com/a" "C:\\x.exe'), 'https://example.com/a%22%20%22C:/x.exe');
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'C:\\x.exe', '', null, 'http://exa mple.com/']) assert.throws(() => util.safeLink(bad), /http/, String(bad));
  });
});

describe('OMP session delete', () => {
  test('"<project>/.jsonl" and "..jsonl" are refused (their artifacts folder would be the project folder)', async () => {
    const { deleteSessions } = await import('../src/sessions.mjs');
    const root = path.join(TMP, 'omp-sessions');
    const proj = path.join(root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'keep.jsonl'), '{}\n');
    const backend = { sessionsRoot: async () => root, hostPath: (p) => p };
    for (const name of ['.jsonl', '..jsonl', ' .jsonl']) await assert.rejects(deleteSessions(backend, [path.join(proj, name)]), (e) => e.status === 400, name);
    assert.ok(fs.existsSync(path.join(proj, 'keep.jsonl')));
    fs.writeFileSync(path.join(proj, 'gone.jsonl'), '{}\n');
    assert.equal(await deleteSessions(backend, [path.join(proj, 'gone.jsonl')]), 1);
    assert.ok(fs.existsSync(path.join(proj, 'keep.jsonl')));
  });
});
