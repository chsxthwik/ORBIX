#!/usr/bin/env node
// Screenshots for the README and the website, taken from a real ORBIX on sample data. No dependencies.
//
//   node tools/shots.mjs            regenerate docs/img/shots/*.png and site/assets/img/shots/*.webp
//   node tools/shots.mjs --serve    set up the same sample data and keep ORBIX running (prints its address)
//   node tools/shots.mjs --keep     keep the temporary folder afterwards (it holds the server log)
//
// It starts ORBIX with ORBIX_DATA in a temporary folder, a small sample project ("shop-api", a git repository) and a
// scripted local model: a tiny OpenAI-compatible server in this file that streams the replies of each scenario
// below. A headless Chromium browser (Microsoft Edge; Chrome, Brave or Chromium when Edge is not installed, or the
// one named by ORBIX_BROWSER) opens ORBIX, and this script drives it over the DevTools protocol: it starts each
// conversation, waits for it to settle, and captures the window.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SERVE = args.includes('--serve');
const KEEP = args.includes('--keep') || SERVE;
const PNG_DIR = path.join(ROOT, 'docs', 'img', 'shots');
const WEBP_DIR = path.join(ROOT, 'site', 'assets', 'img', 'shots');
const VIEW = { width: 1200, height: 759 }; // every shot is this window; the scale sets the pixel size
// The sample project lives in a temporary folder whose path names the user's account. Screens show it as this instead.
const SHOWN_ROOT = process.platform === 'win32' ? 'C:\\Projects' : '/home/you/projects';
let tmpRoot = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + '\n');

// ============================================================================ sample project

const PROJECT_FILES = {
  'package.json': JSON.stringify({ name: 'shop-api', version: '0.3.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'README.md': '# shop-api\n\nAccounts and sign-in for the shop.\n\n    npm test\n',
  'src/users.js': [
    '// Accounts, keyed by lower-case email address.',
    'export const users = new Map([',
    "  ['mia@shop.test', { id: 1, name: 'Mia', password: 'h4sh:tulip' }],",
    "  ['sam@shop.test', { id: 2, name: 'Sam', password: 'h4sh:cedar' }],",
    ']);',
    '',
    'export function findByEmail(email) {',
    '  return users.get(email) || null;',
    '}',
    '',
  ].join('\n'),
  'src/auth.js': [
    "import { findByEmail } from './users.js';",
    '',
    'export function login(email, password) {',
    '  const user = findByEmail(email.trim());',
    '  if (!user || user.password !== `h4sh:${password}`) return null;',
    '  return { id: user.id, name: user.name };',
    '}',
    '',
  ].join('\n'),
  'src/reset.js': [
    "import crypto from 'node:crypto';",
    '',
    'const TTL_MS = 60 * 1000; // one hour',
    '',
    'export function resetLink(user, now = Date.now()) {',
    "  const token = crypto.randomBytes(16).toString('hex');",
    '  return { url: `https://shop.test/reset/${token}`, userId: user.id, expiresAt: now + TTL_MS };',
    '}',
    '',
  ].join('\n'),
  'test/auth.test.js': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { login } from '../src/auth.js';",
    '',
    "test('signs in with the right password', () => assert.equal(login('mia@shop.test', 'tulip')?.name, 'Mia'));",
    "test('refuses a wrong password', () => assert.equal(login('mia@shop.test', 'oak'), null));",
    "test('ignores capital letters in the email', () => assert.equal(login('Mia@Shop.test', 'tulip')?.name, 'Mia'));",
    '',
  ].join('\n'),
};

function makeProject(dir) {
  for (const [rel, text] of Object.entries(PROJECT_FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const git = (...a) => execFileSync('git', ['-c', 'user.name=ORBIX', '-c', 'user.email=shots@orbix.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore' });
  try {
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'Accounts and sign-in');
  } catch {
    say('git is not available: the sample project is not a repository, so the Changes panel stays empty.');
  }
}

// ============================================================================ scripted model

const MODEL = 'orbix-demo';

/** What the model says, step by step, for each scenario. A step: { text, tools: [[name, args]] }. */
const SCENARIOS = [
  {
    match: /how this project is put together/i,
    steps: [
      { text: 'I will look at the layout first.', tools: [['read', { path: 'package.json' }], ['read', { path: 'src/auth.js' }]] },
      { text: 'shop-api is a small Node module with no dependencies.\n\n- `src/users.js` holds the accounts, keyed by lower-case email address, and `findByEmail()` looks one up.\n- `src/auth.js` has `login()`, which checks the password against the stored hash.\n- `src/reset.js` makes password reset links.\n- `test/` runs with `node --test` (`npm test`).\n\nStart with `src/auth.js`: it is the only module that calls the others.' },
    ],
  },
  {
    match: /capital letters/i,
    steps: [
      { text: 'I will find where login looks users up.', tools: [['grep', { pattern: 'findByEmail', path: 'src' }], ['read', { path: 'src/auth.js' }], ['read', { path: 'src/users.js' }]] },
      { text: '`login()` looks the email up exactly as typed, and `users` is keyed by lower-case addresses, so `Mia@Shop.test` never matches `mia@shop.test`. Lower-casing it before the lookup fixes that.', tools: [['edit', { path: 'src/auth.js', old_string: 'findByEmail(email.trim())', new_string: 'findByEmail(email.trim().toLowerCase())' }]] },
      { text: '', tools: [['bash', { command: 'node --test' }]] },
      { text: 'Fixed: `login()` now lower-cases the email before the lookup, and all three tests pass.' },
    ],
  },
  {
    match: /reset links/i,
    steps: [
      { text: 'I will look at how reset links are made.', tools: [['read', { path: 'src/reset.js' }]] },
      { text: '`TTL_MS` is 60,000 ms, which is one minute. The comment says one hour, so the number is wrong, not the comment.', tools: [['edit', { path: 'src/reset.js', old_string: 'const TTL_MS = 60 * 1000; // one hour', new_string: 'const TTL_MS = 60 * 60 * 1000; // one hour' }]] },
      { text: 'Links now last an hour.' },
    ],
  },
];

const textOfContent = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '');

function scriptFor(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = textOfContent(msgs.find((m) => m.role === 'user')?.content);
  const scenario = SCENARIOS.find((s) => s.match.test(firstUser));
  // Helper calls (no tools offered) and anything unscripted get a short plain answer.
  if (!scenario || !Array.isArray(body.tools)) return { text: 'Done.' };
  const step = msgs.filter((m) => m.role === 'assistant').length;
  return scenario.steps[Math.min(step, scenario.steps.length - 1)];
}

function startModelServer() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'orbix' }] }));
    }
    if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url)) {
      res.writeHead(404);
      return res.end();
    }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
      }
      const step = scriptFor(body);
      const id = `chatcmpl-${++calls}`;
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: MODEL, choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ delta: { role: 'assistant' }, finish_reason: null }));
      // Text arrives in a few pieces, as from a real model.
      const words = (step.text || '').split(/(?<= )/);
      for (let i = 0; i < words.length; i += 6) {
        res.write(chunk({ delta: { content: words.slice(i, i + 6).join('') }, finish_reason: null }));
        await sleep(8);
      }
      (step.tools || []).forEach(([name, a], i) => {
        res.write(chunk({ delta: { tool_calls: [{ index: i, id: `call_${calls}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(a) } }] }, finish_reason: null }));
      });
      res.write(chunk({ delta: {}, finish_reason: step.tools?.length ? 'tool_calls' : 'stop' }));
      const prompt = 6000 + JSON.stringify(body.messages || []).length / 4;
      res.write(chunk(null, { usage: { prompt_tokens: Math.round(prompt), completion_tokens: 40 + Math.round((step.text || '').length / 4) } }));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ============================================================================ ORBIX

async function startOrbix(data, modelPort) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ version: 1, backend: { kind: 'native', distro: '' }, backendChosen: true, ui: { theme: 'dark', rightPanel: true, rightTab: 'files', showThinking: true, autoScroll: true } }, null, 2));
  fs.writeFileSync(path.join(data, 'engine.json'), JSON.stringify({
    approvals: 'edits',
    trusted: ['node --test'],
    providers: { custom: { enabled: true, baseUrl: `http://127.0.0.1:${modelPort}/v1`, models: 1 } },
    defaultModel: `custom/${MODEL}`,
    verify: 'off',
    review: false,
  }, null, 2));
  const log = fs.openSync(path.join(data, 'orbix.out.log'), 'a');
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'main.mjs'), '--no-open', '--port', '47990'], { cwd: ROOT, env: { ...process.env, ORBIX_DATA: data }, stdio: ['ignore', log, log], windowsHide: true });
  const lock = path.join(data, 'instance.json');
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (proc.exitCode != null) throw new Error(`ORBIX exited (code ${proc.exitCode}); see ${path.join(data, 'orbix.out.log')}`);
    try {
      const { port, token } = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (port && token) return { proc, port, token, url: `http://127.0.0.1:${port}/?t=${token}` };
    } catch {}
  }
  proc.kill();
  throw new Error('ORBIX did not start within 15 seconds');
}

// ============================================================================ browser (DevTools protocol)

function findBrowser() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const list = [
    process.env.ORBIX_BROWSER,
    `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${local}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
    `${local}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    `${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const hit = list.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('No Chromium browser found. Install Microsoft Edge or Chrome, or set ORBIX_BROWSER to one.');
  return hit;
}

async function startBrowser(dir) {
  const exe = findBrowser();
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(dir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try {
      port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
    } catch {}
  }
  if (!port) throw new Error(`${path.basename(exe)} did not open its DevTools port`);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === 'page');
  const cdp = await connect(page.webSocketDebuggerUrl);
  say(`Browser: ${exe}`);
  return { proc, cdp, name: path.basename(exe) };
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
        msg.error ? fail(new Error(`${msg.error.message}${msg.error.data ? ': ' + msg.error.data : ''}`)) : ok(msg.result);
      } else if (msg.method) for (const fn of listeners) fn(msg);
    };
    ws.onerror = () => reject(new Error('Could not connect to the browser'));
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((ok, fail) => {
        const id = ++seq;
        waiting.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      on: (fn) => listeners.add(fn),
      close: () => ws.close(),
    });
  });
}

/** The page: evaluate code in it, wait for a condition, press keys, capture it. */
function pageOf(cdp) {
  const errors = [];
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim());
  });
  const P = {
    errors,
    async eval(expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async until(cond, what, ms = 20000) {
      const t0 = Date.now();
      for (;;) {
        if (await P.eval(`try { return !!(${cond}); } catch { return false; }`)) return;
        if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
        await sleep(120);
      }
    },
    async scale(dsf) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: dsf, mobile: false });
      await sleep(250);
    },
    async key(key, { ctrl = false, code = key, keyCode = 0 } = {}) {
      const base = { key, code, modifiers: ctrl ? 2 : 0, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    type: (text) => cdp.send('Input.insertText', { text }),
    /** Show the temporary folder as SHOWN_ROOT in every text and tooltip on screen. */
    tidyPaths: () => P.eval(`
      const from = ${JSON.stringify(tmpRoot)}, to = ${JSON.stringify(SHOWN_ROOT)};
      const fix = (s) => s.split(from).join(to);
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(from)) n.data = fix(n.data);
      for (const el of document.querySelectorAll('[title]')) if (el.title.includes(from)) el.title = fix(el.title);`),
    /** Let pending work settle and draw: fonts, two frames, then a short pause. */
    async settle(ms = 400) {
      await P.eval('await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));');
      await sleep(ms);
    },
    /** `webp`: also write the website's WebP, at `webpDsf` when it is smaller than the PNG. */
    async capture(name, { dsf, webp = false, webpDsf = dsf } = {}) {
      await P.tidyPaths();
      await P.scale(dsf);
      await P.settle();
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(PNG_DIR, `${name}.png`), Buffer.from(png.data, 'base64'));
      if (webp) {
        if (webpDsf !== dsf) {
          await P.scale(webpDsf);
          await P.settle();
        }
        const w = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 82 });
        fs.writeFileSync(path.join(WEBP_DIR, `${name}.webp`), Buffer.from(w.data, 'base64'));
      }
      say(`  ${name}.png${webp ? ` + ${name}.webp` : ''}`);
    },
  };
  return P;
}

// ============================================================================ scenes

const PROMPTS = {
  explain: 'Explain how this project is put together.',
  done: 'Customers cannot log in when their email has capital letters. Find out why and fix it.',
  approval: 'Password reset links expire after a minute instead of an hour. Fix it.',
};

/** Start a conversation in the sample project and wait until the agent is done or waits for an approval. */
async function converse(page, key, { waitFor = 'done' } = {}) {
  await page.eval(`
    const st = await import('/js/store.js');
    const tab = await st.openTab({ workspace: window.__shotProject });
    window.__tabs = { ...(window.__tabs || {}), ${key}: tab.id };
    await st.sendPrompt(tab, ${JSON.stringify(PROMPTS[key])});`);
  const tab = `(await import('/js/store.js')).S.tabs.get(window.__tabs.${key})`;
  await sleep(300);
  if (waitFor === 'approval') await page.until(`document.querySelector('.approval') && ${tab}.dialogs.length`, 'the approval card');
  else await page.until(`(${tab}) && !(${tab}).streaming && (${tab}).messages.at(-1)?.role === 'assistant' && (${tab}).messages.at(-1).content?.some?.((c) => c.type === 'text')`, `the "${key}" reply`);
  await page.settle(600);
}

const setTheme = (page, theme) => page.eval(`(await import('/js/store.js')).savePrefs({ theme: ${JSON.stringify(theme)} }); await new Promise((r) => setTimeout(r, 250));`);

async function showPanelTab(page, label) {
  await page.eval(`document.querySelector('.ptab[aria-label=${JSON.stringify(label)}]')?.click();`);
  await page.settle(300);
}

async function scenes(page, project) {
  await page.eval(`window.__shotProject = ${JSON.stringify(project)};
    const { api } = await import('/js/api.js');
    await api.post('/api/workspaces', { path: window.__shotProject });`);
  // Reload so the sidebar and Home pick up the project.
  await page.eval('location.reload()').catch(() => {});
  await sleep(500);
  await page.until("document.readyState === 'complete' && document.querySelector('.home .home-composer')", 'Home');
  await page.eval(`window.__shotProject = ${JSON.stringify(project)};`);
  await setTheme(page, 'dark');

  say('Conversations');
  await converse(page, 'explain');
  await page.eval(`const st = await import('/js/store.js'); await st.closeTab(window.__tabs.explain);`);
  await converse(page, 'done');

  say('Screens');
  // The finished task with the conversation at full width: the applied diff, Undo, and the summary of the run.
  const panel = (on) => page.eval(`(await import('/js/store.js')).savePrefs({ rightPanel: ${on} }); await new Promise((r) => setTimeout(r, 300));`);
  const toEnd = "const tr = document.querySelector('.session:not([hidden]) .transcript'); tr.scrollTop = tr.scrollHeight;";
  await panel(false);
  await page.eval(toEnd);
  await page.capture('done', { dsf: 4 / 3, webp: true });

  // Themes: the same finished task.
  for (const [theme, webp] of [['dark', false], ['light', true], ['midnight', true], ['frost', true]]) {
    await setTheme(page, theme);
    await page.eval(toEnd);
    await page.capture(`theme-${theme}`, { dsf: 1, webp });
  }
  await setTheme(page, 'dark');
  await panel(true);
  await showPanelTab(page, 'Files');

  // Search (Ctrl+K), looking for a file.
  await page.eval("document.querySelector('.c-ta')?.blur()");
  await page.key('k', { ctrl: true, code: 'KeyK', keyCode: 75 });
  await page.until("document.querySelector('.palette .pal-q')", 'the search palette');
  await page.eval("document.querySelector('.palette .pal-q').focus()");
  await page.type('auth');
  await page.until("[...document.querySelectorAll('.pal-list .list-h')].some((x) => x.textContent === 'Files') && !document.querySelector('.pal-busy')", 'file results');
  await page.capture('palette', { dsf: 4 / 3, webp: true });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.settle(300);

  // Settings on Providers.
  await page.eval("(await import('/js/store.js')).emit('settings', 'engine')");
  await page.until("document.querySelector('.settings .pv-list .pv-card')", 'the providers page');
  await page.eval('document.activeElement?.blur()');
  await page.capture('settings', { dsf: 4 / 3, webp: true });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.settle(300);

  // An edit waiting for approval: approvals switch to "ask first" for this one.
  await page.eval("const { api } = await import('/js/api.js'); await api.post('/api/engine/settings', { approvals: 'ask' }); await (await import('/js/store.js')).loadEngine();");
  await converse(page, 'approval', { waitFor: 'approval' });
  await page.capture('approval', { dsf: 2, webp: true, webpDsf: 4 / 3 });

  // Home, with that approval waiting and the conversations so far.
  await page.eval("(await import('/js/store.js')).emit('home')");
  await page.until("document.querySelector('.home .home-composer') && document.querySelector('.library-row')", 'Home');
  await page.eval("document.querySelector('.welcome')?.scrollTo({ top: 0 })");
  await page.capture('home', { dsf: 4 / 3, webp: true });
}

// ============================================================================ main

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-shots-'));
  tmpRoot = tmp;
  const project = path.join(tmp, 'shop-api');
  const data = path.join(tmp, 'data');
  makeProject(project);
  const model = await startModelServer();
  const orbix = await startOrbix(data, model.address().port);
  let browser = null;
  const stop = async () => {
    try {
      browser?.cdp.close();
    } catch {}
    browser?.proc.kill();
    orbix.proc.kill();
    model.close();
    await sleep(800);
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  if (SERVE) {
    say(`Sample project: ${project}`);
    say(`ORBIX: ${orbix.url}`);
    say('Prompts the scripted model answers:');
    for (const p of Object.values(PROMPTS)) say(`  ${p}`);
    say('Press Ctrl+C to stop.');
    process.on('SIGINT', () => stop().then(() => process.exit(0)));
    return;
  }
  try {
    browser = await startBrowser(path.join(tmp, 'browser'));
    const { cdp } = browser;
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
    // Still frames: no motion, so a capture never lands mid-animation.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'dark' }] });
    const page = pageOf(cdp);
    await page.scale(1);
    await cdp.send('Page.navigate', { url: orbix.url });
    await page.until("document.readyState === 'complete' && document.querySelector('.app')", 'ORBIX to load');
    fs.mkdirSync(PNG_DIR, { recursive: true });
    fs.mkdirSync(WEBP_DIR, { recursive: true });
    await scenes(page, project);
    const errs = page.errors.filter(Boolean);
    if (errs.length) say(`Console errors:\n  ${errs.join('\n  ')}`);
    else say('Console: no errors');
  } finally {
    await stop();
  }
  say(`Done. PNG: ${path.relative(ROOT, PNG_DIR)}  WebP: ${path.relative(ROOT, WEBP_DIR)}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
