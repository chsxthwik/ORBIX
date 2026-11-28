// Shared parts of the desktop end-to-end tests: a deterministic model (a small OpenAI-compatible server that
// replays scripted steps), a fixture repository, ORBIX itself on a temporary data folder, and a Chromium window
// driven over the DevTools protocol. No dependencies, no network, no API keys.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop a browser and every helper process it started. On Windows some helpers detach from the main process and keep
 * writing the profile, so a temporary folder could not be removed: they are found by the profile folder in their
 * command line.
 */
export function killTree(proc, profile = '') {
  if (process.platform === 'win32') {
    if (proc?.pid && proc.exitCode == null) {
      try {
        execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch {}
    }
    if (profile) {
      const like = profile.replace(/'/g, "''").replace(/[[\]*?]/g, '`$&');
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
      } catch {}
    }
    return;
  }
  proc?.kill();
}
export const MODEL = 'orbix-fixture';

// ---- Fixture repository ---------------------------------------------------------------------------------------------

const FILES = {
  'package.json': JSON.stringify({ name: 'shop-api', version: '0.3.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# shop-api\n\nAccounts and sign-in for the shop.\n',
  'src/users.js': "// Accounts, keyed by lower-case email address.\nexport const users = new Map([\n  ['mia@shop.test', { id: 1, name: 'Mia' }],\n  ['sam@shop.test', { id: 2, name: 'Sam' }],\n]);\n\nexport const findByEmail = (email) => users.get(email) || null;\n",
  'src/auth.js': "import { findByEmail } from './users.js';\n\n/** The account for this email, or null. */\nexport function login(email) {\n  return findByEmail(email);\n}\n",
  'test/auth.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { login } from '../src/auth.js';\n\ntest('a known email signs in', () => {\n  assert.equal(login('mia@shop.test').name, 'Mia');\n});\n",
};

// The test machine may have no git identity; the fixture brings its own, as a developer's computer would have one.
const IDENTITY = { GIT_AUTHOR_NAME: 'ORBIX e2e', GIT_AUTHOR_EMAIL: 'e2e@orbix.test', GIT_COMMITTER_NAME: 'ORBIX e2e', GIT_COMMITTER_EMAIL: 'e2e@orbix.test' };
export const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } });

export function makeRepo(dir) {
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'Start');
  return dir;
}

// ---- Deterministic model --------------------------------------------------------------------------------------------

const PLAN_1 = '# Fix sign-in for emails with capital letters\n\n## Goal\n`login()` must find an account whatever the letter case of the email.\n\n## Changes\n- `src/auth.js`: lower-case the email before the lookup.\n- `test/auth.test.js`: add a test with `Mia@Shop.test`.\n\n## Verification\nRun `npm test`.\n';
const PLAN_2 = PLAN_1.replace('lower-case the email before the lookup.', 'trim and lower-case the email before the lookup.').replace('add a test with `Mia@Shop.test`.', 'add tests with `Mia@Shop.test` and with spaces around the address.');
const WALK = '# Walkthrough\n\n## What changed\n- `src/auth.js`: the email is trimmed and lower-cased before the lookup.\n- `test/auth.test.js`: two new tests (capital letters, surrounding spaces).\n\n## Verification\n`npm test` passes: 3 tests, 0 failures.\n';
const NEW_AUTH = "import { findByEmail } from './users.js';\n\n/** The account for this email, or null. Letter case and surrounding spaces do not matter. */\nexport function login(email) {\n  return findByEmail(String(email).trim().toLowerCase());\n}\n";
const NEW_TEST = FILES['test/auth.test.js'] + "\ntest('capital letters in the email do not matter', () => {\n  assert.equal(login('Mia@Shop.test').name, 'Mia');\n});\n\ntest('spaces around the email do not matter', () => {\n  assert.equal(login('  sam@shop.test ').name, 'Sam');\n});\n";

/** What the model does, step by step, for each task. The step is chosen by how many replies it has given so far. */
export const SCENARIOS = [
  {
    name: 'tools after initial text',
    match: /activity after a partial reply/i,
    steps: [
      { text: 'Initial text, not the finished answer.', finish: 'length' },
      { tools: [['bash', { command: 'git status --short', description: 'check the fixture working tree' }]] },
      { text: 'Final answer after the check.' },
    ],
  },
  {
    name: 'bug fix with a plan',
    match: /capital letters/i,
    steps: [
      { text: 'I will look at how sign-in finds an account.', tools: [['read', { path: 'src/auth.js' }], ['read', { path: 'src/users.js' }], ['read', { path: 'test/auth.test.js' }]] },
      { tools: [['artifact', { kind: 'plan', title: 'Fix sign-in for emails with capital letters', content: PLAN_1 }]] },
      { text: 'The plan is ready: lower-case the email in `login()` and add a test.' },
      // after your feedback
      { tools: [['artifact', { kind: 'plan', title: 'Fix sign-in for emails with capital letters', content: PLAN_2 }]] },
      { text: 'Revised: the email is also trimmed, with a test for it.' },
      // after your approval
      { tools: [['write', { path: 'src/auth.js', content: NEW_AUTH }]] },
      { tools: [['write', { path: 'test/auth.test.js', content: NEW_TEST }]] },
      { tools: [['bash', { command: 'npm test' }]] },
      { tools: [['artifact', { kind: 'walkthrough', content: WALK }]] },
      { text: 'Done: sign-in ignores letter case and surrounding spaces, and the tests pass.' },
    ],
  },
  {
    name: 'a destructive command is denied',
    match: /publish the docs/i,
    steps: [
      { text: 'I will push the branch.', tools: [['bash', { command: 'git push origin main' }]] },
      { text: 'The push was denied, so I stopped. Nothing was changed.' },
    ],
  },
  {
    name: 'interrupted by a restart',
    match: /changelog/i,
    steps: [
      { tools: [['artifact', { kind: 'plan', content: '# Add a changelog\n\n- Create `CHANGELOG.md` with the first entry.\n- Verify by listing the file.\n' }]] },
      { text: 'The plan is ready.' },
      { tools: [['write', { path: 'CHANGELOG.md', content: '# Changelog\n\n## 0.3.0\n- Sign-in fixes.\n' }]] },
      { text: 'Checking.', tools: [['bash', { command: 'node -e "setTimeout(() => {}, 25000)"' }]] },
      // after the restart and your OK
      { tools: [['bash', { command: 'git status --short' }]] },
      { tools: [['artifact', { kind: 'walkthrough', content: '# Walkthrough\n\n`CHANGELOG.md` was added. After the restart I checked `git status` first: the file was already written, so nothing was repeated.\n' }]] },
      { text: 'Recovered: the changelog is in place.' },
    ],
  },
  {
    name: 'conversation: explain and fix',
    match: /explain sign-in/i,
    steps: [
      { text: 'I will read the sign-in code and its test.', tools: [['read', { path: 'src/auth.js' }], ['read', { path: 'src/users.js' }]] },
      { tools: [['grep', { pattern: 'findByEmail', path: 'src' }]] },
      { text: 'Lower-casing the email before the lookup fixes mixed-case addresses.', tools: [['edit', { path: 'src/auth.js', old_string: 'return findByEmail(email);', new_string: 'return findByEmail(String(email).toLowerCase());' }]] },
      { tools: [['bash', { command: 'npm test' }]] },
      { text: 'Sign-in looks the account up in `users`, which is keyed by lower-case email. `login()` passed the address as typed, so `Mia@Shop.test` found nothing.\n\nI changed `login()` to lower-case the email first. The test suite passes.' },
    ],
  },
  {
    name: 'second run for the conflict',
    match: /readme title/i,
    steps: [{ tools: [['read', { path: 'README.md' }]] }, { tools: [['edit', { path: 'README.md', old_string: '# shop-api', new_string: '# shop-api (accounts)' }]] }, { text: 'Retitled.' }],
  },
];

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '');

export function startModel() {
  const seen = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'orbix' }] }));
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) return res.writeHead(404).end();
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const first = textOf(msgs.find((m) => m.role === 'user')?.content);
      const sc = SCENARIOS.find((s) => s.match.test(first));
      const n = msgs.filter((m) => m.role === 'assistant').length;
      const step = sc && Array.isArray(body.tools) ? sc.steps[Math.min(n, sc.steps.length - 1)] : { text: 'Done.' };
      seen.push({ scenario: sc?.name || '', step: n, tools: (body.tools || []).map((t) => t.function?.name), last: textOf(msgs.at(-1)?.content).slice(0, 2000) });
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
      }
      const id = `chatcmpl-${++calls}`;
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: MODEL, choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ delta: { role: 'assistant' }, finish_reason: null }));
      if (step.text) res.write(chunk({ delta: { content: step.text }, finish_reason: null }));
      (step.tools || []).forEach(([name, a], i) => res.write(chunk({ delta: { tool_calls: [{ index: i, id: `call_${calls}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(a) } }] }, finish_reason: null })));
      res.write(chunk({ delta: {}, finish_reason: step.finish || (step.tools?.length ? 'tool_calls' : 'stop') }));
      res.write(chunk(null, { usage: { prompt_tokens: 1200, completion_tokens: 60 } }));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

// ---- ORBIX ----------------------------------------------------------------------------------------------------------

export function writeConfig(data, modelPort, projects) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ version: 1, backend: { kind: 'native', distro: '' }, backendChosen: true, workspaces: projects.map((p, i) => ({ id: `w${i}`, path: p, name: path.basename(p), added: Date.now() })), ui: { rightPanel: true, rightTab: 'files', showThinking: true, autoScroll: true, layout: 2 } }, null, 2));
  fs.writeFileSync(path.join(data, 'engine.json'), JSON.stringify({ approvals: 'ask', trusted: [], providers: { custom: { enabled: true, baseUrl: `http://127.0.0.1:${modelPort}/v1`, models: 1 } }, defaultModel: `custom/${MODEL}`, verify: 'ask', review: false }, null, 2));
}

/** Start the ORBIX server (its own process) on `data`. Returns { proc, url, port, token }. */
export async function startOrbix(data, port = 47991) {
  const log = fs.openSync(path.join(data, 'orbix.out.log'), 'a');
  const before = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(data, 'instance.json'), 'utf8')).token;
    } catch {
      return '';
    }
  })();
  const start = `const { startOrbix } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'app.mjs')).href)}); await startOrbix({ port: ${port} });`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', start], { cwd: ROOT, env: { ...process.env, ORBIX_DATA: data, ...IDENTITY }, stdio: ['ignore', log, log], windowsHide: true });
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (proc.exitCode != null) throw new Error(`ORBIX exited (code ${proc.exitCode}); see ${path.join(data, 'orbix.out.log')}`);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(data, 'instance.json'), 'utf8'));
      if (j.port && j.token && j.token !== before) return { proc, port: j.port, token: j.token, url: `http://127.0.0.1:${j.port}/?t=${j.token}` };
    } catch {}
  }
  proc.kill();
  throw new Error('ORBIX did not start within 20 seconds');
}

// ---- Browser --------------------------------------------------------------------------------------------------------

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [process.env.ORBIX_BROWSER, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, `${local}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${local}\\Google\\Chrome\\Application\\chrome.exe`, `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const hit = list.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('No Chromium browser found. Install Microsoft Edge or Chrome, or set ORBIX_BROWSER.');
  return hit;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const waiting = new Map();
    const listeners = new Set();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && waiting.has(msg.id)) {
        const { ok, fail } = waiting.get(msg.id);
        waiting.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) for (const fn of listeners) fn(msg);
    };
    ws.onerror = () => reject(new Error('Could not connect to the browser'));
    ws.onopen = () => resolve({ send: (method, params = {}) => new Promise((ok, fail) => (waiting.set(++seq, { ok, fail }), ws.send(JSON.stringify({ id: seq, method, params })))), on: (fn) => listeners.add(fn), close: () => ws.close() });
  });
}

/** A window on ORBIX. `scale`: the device scale factor (2 checks high-DPI rendering). */
export async function startBrowser(dir, { width = 1360, height = 860, scale = 1 } = {}) {
  const exe = findBrowser();
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try {
      port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch {}
  }
  if (!port) throw new Error('The browser did not open its DevTools port');
  const pages = await debugPages(port);
  return connectPage(exe, proc, pages.find((p) => p.type === 'page'), { width, height, scale }, dir);
}

const debugPages = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();

/** Run the same UI checks in the packaged Electron host, isolated from the installed app. */
export async function startDesktop(exe, data, profile, appDir) {
  const proc = spawn(exe, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, ...(appDir ? [appDir] : [])], {
    cwd: ROOT,
    env: { ...process.env, ORBIX_DATA: data, ORBIX_NO_UPDATES: '1', ...IDENTITY },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let spawnError;
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  proc.on('error', (e) => { spawnError = e; });
  let port;
  try {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError;
      if (proc.exitCode != null) throw new Error(`Electron exited (code ${proc.exitCode})`);
      port ||= Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
      if (!port) {
        try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
      }
      if (port) {
        const pages = await debugPages(port).catch(() => []);
        const target = pages.find((p) => p.type === 'page' && (p.url.startsWith('orbix://app/') || p.url.startsWith('http://127.0.0.1:')));
        if (target) return await connectPage(exe, proc, target, undefined, profile);
      }
      await sleep(100);
    }
    throw new Error('The ORBIX Electron window did not open');
  } catch (e) {
    proc.kill();
    throw e;
  }
}

async function connectPage(exe, proc, target, metrics, profile = '') {
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable ORBIX window found');
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  if (metrics) {
    const { width, height, scale } = metrics;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  }
  const errors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
  });
  const P = {
    errors,
    proc,
    exe,
    cdp, // the raw DevTools connection, for tools that need more than the helpers below (tools/perf.mjs)
    async eval(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async until(cond, what, ms = 25000) {
      const t0 = Date.now();
      for (;;) {
        // Awaited: a condition written as an async function would otherwise be a promise, which is always true.
        if (await P.eval(`try { return !!(await (${cond})); } catch { return false; }`).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    async goto(url) {
      await cdp.send('Page.navigate', { url });
      await P.until(`document.querySelector('#sidebar .side-nav')`, 'ORBIX to load');
    },
    /** Click the first visible, enabled button whose text matches, inside `scope` (a CSS selector). Waits for it to appear. */
    async click(text, scope = 'body', ms = 12000) {
      const t0 = Date.now();
      for (;;) {
        const ok = await P.eval(`
          const want = ${JSON.stringify(text)};
          const root = [...document.querySelectorAll(${JSON.stringify(scope)})].pop();
          const b = root && [...root.querySelectorAll('button, [role=tab], label')].find((x) => x.offsetParent && !x.disabled && x.getAttribute('aria-disabled') !== 'true' && (x.textContent.trim().startsWith(want) || x.title === want || x.getAttribute('aria-label') === want));
          if (!b) return false;
          b.scrollIntoView({ block: 'center' });
          b.click();
          return true;`).catch(() => false);
        if (ok) break;
        if (Date.now() - t0 > ms) throw new Error(`No button "${text}" in ${scope}`);
        await sleep(100);
      }
      await sleep(60);
    },
    fill: (selector, text) => P.eval(`const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((x) => x.offsetParent).pop(); if (!el) throw new Error('No field ' + ${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true }));`),
    text: (selector) => P.eval(`return [...document.querySelectorAll(${JSON.stringify(selector)})].map((x) => x.innerText).join('\\n')`),
    async key(key, { ctrl = false, keyCode = 0, code = key } = {}) {
      const base = { key, code, modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    },
    /**
     * A key as a real keyboard sends it: keyDown with its text, then keyUp. Unlike key(), Enter here also activates
     * whatever button has the focus after the keyDown handlers ran, as it does for a person.
     */
    async press(key, keyCode, { code = key } = {}) {
      const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(80);
    },
    /** Type text into the focused field, as a keyboard would. */
    type: (text) => cdp.send('Input.insertText', { text }),
    /** A real mouse click (count 2: a double-click, with both clicks before it) at the centre of the element. */
    async mouse(selector, count = 1) {
      const r = await P.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);
      if (!r) throw new Error(`Nothing to click at ${selector}`);
      for (let i = 1; i <= count; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: i });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: i });
      }
      await sleep(80);
    },
    async shot(file) {
      await P.eval('await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));');
      await sleep(250);
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    },
    close: () => (cdp.close(), killTree(proc, profile)),
  };
  return P;
}

export const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ORBIX e2e ñ-'));
