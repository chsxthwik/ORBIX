#!/usr/bin/env node
// Screenshots for the README and the website, taken from a real ORBIX on sample data. No dependencies.
//
//   node tools/shots.mjs            regenerate docs/img/shots/*.png and site/assets/img/shots/*.webp (full, -1200 and -800)
//   node tools/shots.mjs --theme graphite   the same, in another theme (Dark by default)
//   node tools/shots.mjs --keep     keep the temporary folder afterwards (it holds the server log)
//   node tools/shots.mjs --visual   visual regression test (npm run visual): every screen in Dark, Light and Graphite at
//                                   scale 1, compared pixel by pixel with the approved PNGs in test/visual/. Diff
//                                   images go to test/visual/diff/; it fails when more than 0.1% of a screen's pixels change
//   node tools/shots.mjs --visual --approve   take the same screens and save them as the new baselines
//   node tools/shots.mjs --visual --only NAME  only the screens whose name starts with NAME (or one of A,B,...) (with or without --approve)
//   node tools/shots.mjs --audit    the same screens, no comparison: checks every screen in every theme against the design
//                                   rules (type scale, weights, 4px spacing, accent only where it belongs, 4.5:1 text
//                                   contrast, clipped or overlapping text) and lists what breaks them (tools/ui-audit.mjs)
//   node tools/shots.mjs --visual --size 2560x1440 --keep   a different window size (the folder with the captures is kept)
//
// Visual mode is deterministic: the clock is frozen (in the browser and in ORBIX), Math.random is seeded, animations,
// transitions and the caret are off, the sample project lives at a fixed path and git uses fixed dates.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng, comparePixels } from './visual-png.mjs';
import { auditPage, focusPrepare, focusProbe, inPage, summarize } from './ui-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const AUDIT = args.includes('--audit');
const COMPARE = args.includes('--visual');
const VISUAL = COMPARE || AUDIT; // the audit takes the same deterministic screens
const APPROVE = COMPARE && args.includes('--approve');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] || '' : '';
// The theme of the README and website screens (`--theme graphite`); the visual test always walks every theme.
const THEME = args.includes('--theme') ? args[args.indexOf('--theme') + 1] || 'dark' : 'dark';
const BASELINES = path.join(ROOT, 'test', 'visual');
let PNG_DIR = path.join(ROOT, 'docs', 'img', 'shots');
const WEBP_DIR = path.join(ROOT, 'site', 'assets', 'img', 'shots');
const VIEW = { width: 1200, height: 759 }; // every shot is this window; the scale sets the pixel size
if (args.includes('--size')) {
  const m = /^(\d+)x(\d+)$/.exec(args[args.indexOf('--size') + 1] || '');
  if (!m) throw new Error('--size takes WIDTHxHEIGHT, for example 1280x800');
  [VIEW.width, VIEW.height] = [+m[1], +m[2]];
} else if (AUDIT) [VIEW.width, VIEW.height] = [1280, 800];
// The sample project lives in a temporary folder whose path names the user's account. Screens show it as this instead.
const SHOWN_ROOT = process.platform === 'win32' ? 'C:\\Projects' : '/home/you/projects';
let tmpRoot = '';
// Visual mode: one moment for every clock. It is before any real file time, so "how long ago" always reads "now".
const FROZEN_ISO = '2026-01-15T10:30:00.000Z';
const SEED = 20260115;
// The project's check: in visual mode a script whose output has no timings in it.
const CHECK = VISUAL ? 'npm test' : 'node --test';
/**
 * Source that freezes Date at FROZEN_ISO and seeds Math.random, for the page and (with `tick`) for ORBIX's own process.
 * ORBIX's clock steps one second at each streamed model request: its messages need distinct times (the page tells them
 * apart by role and time), and the requests come in the same order on every run, so every time is the same each run.
 */
const clockSource = (tick) => `(() => {
  let T = Date.parse(${JSON.stringify(FROZEN_ISO)});
  const D = Date;
  globalThis.Date = new Proxy(D, {
    construct: (t, a, nt) => Reflect.construct(t, a.length ? a : [T], nt),
    apply: () => new D(T).toString(),
    get: (t, k) => (k === 'now' ? () => T : Reflect.get(t, k)),
  });
  ${tick ? `const f = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (/\\/chat\\/completions$/.test(String(url)) && /"stream":true/.test(String(init?.body || ''))) T += 1000;
    return f(url, init);
  };` : ''}
  let s = ${SEED};
  Math.random = () => { s = (s + 0x6D2B79F5) | 0; let x = Math.imul(s ^ (s >>> 15), 1 | s); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
})();`;
const freezeClock = clockSource(false);
/** The temporary folder as screens may show it: as is, and under WSL also as Windows writes it. */
function tmpRoots() {
  const list = [tmpRoot];
  if (process.env.WSL_DISTRO_NAME && tmpRoot.startsWith('/mnt/')) {
    try {
      list.push(execFileSync('wslpath', ['-w', tmpRoot], { encoding: 'utf8' }).trim());
    } catch {}
  }
  return list;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => process.stdout.write(s + '\n');

// ============================================================================ sample project

const VERIFY_JS = [
  '// The checks, without timings in the output (the visual tests compare screens that show it).',
  "import assert from 'node:assert/strict';",
  "import fs from 'node:fs';",
  "const { login } = await import('./src/auth.js');",
  "assert.equal(login('mia@shop.test', 'tulip')?.name, 'Mia');",
  "assert.equal(login('mia@shop.test', 'oak'), null);",
  "assert.equal(login('Mia@Shop.test', 'tulip')?.name, 'Mia');",
  'let n = 3;',
  "if (fs.existsSync('src/limit.js')) {",
  "  const { allowed, failed } = await import('./src/limit.js');",
  "  for (let i = 0; i < 5; i++) failed('sam@shop.test', 1000);",
  "  assert.equal(allowed('Sam@Shop.test', 2000), false);",
  "  assert.equal(allowed('sam@shop.test', 62000), true);",
  '  n++;',
  '}',
  'console.log(`${n} checks passed`);',
  '',
].join('\n');

const PROJECT_FILES = {
  'package.json': JSON.stringify({ name: 'shop-api', version: '0.3.0', private: true, type: 'module', scripts: { test: VISUAL ? 'node verify.js' : 'node --test' } }, null, 2) + '\n',
  ...(VISUAL ? { 'verify.js': VERIFY_JS } : {}),
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

// Fixed commit dates, so commits (and their hashes) are the same on every visual run.
const GIT_DATES = VISUAL ? { GIT_AUTHOR_DATE: FROZEN_ISO, GIT_COMMITTER_DATE: FROZEN_ISO, GIT_AUTHOR_NAME: 'ORBIX', GIT_AUTHOR_EMAIL: 'shots@orbix.invalid', GIT_COMMITTER_NAME: 'ORBIX', GIT_COMMITTER_EMAIL: 'shots@orbix.invalid' } : {};
// Under WSL, git.exe sees only the variables WSLENV names.
if (VISUAL && process.env.WSL_DISTRO_NAME) GIT_DATES.WSLENV = [process.env.WSLENV, ...Object.keys(GIT_DATES)].filter(Boolean).join(':');

function makeProject(dir) {
  for (const [rel, text] of Object.entries(PROJECT_FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  // Under WSL a project on the Windows drive gets Windows' git, the one ORBIX uses for it.
  const exe = process.env.WSL_DISTRO_NAME && dir.startsWith('/mnt/') ? 'git.exe' : 'git';
  const git = (...a) => execFileSync(exe, ['-c', 'user.name=ORBIX', '-c', 'user.email=shots@orbix.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'ignore', env: { ...process.env, ...GIT_DATES } });
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
      { text: '', tools: [['bash', { command: CHECK }]] },
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

// A run (Runs view): it plans first, then works in its own worktree after the plan is approved.
const RUN_PLAN = '# Limit failed sign-ins\n\n## Goal\nAfter 5 wrong passwords for one email within a minute, `login()` refuses that email until the minute is over.\n\n## Changes\n- `src/limit.js` (new): counts failed attempts per lower-cased email in a one-minute window.\n- `src/auth.js`: check the limit before the password, and record each failure.\n- `test/limit.test.js` (new): five failures lock the email; a minute later it works again.\n\n## Verification\n`node --test test/limit.test.js`\n';
const LIMIT_JS = "// Failed sign-ins per email, in a sliding one-minute window.\nconst WINDOW_MS = 60 * 1000;\nconst MAX_FAILS = 5;\nconst fails = new Map();\n\nexport function allowed(email, now = Date.now()) {\n  const list = (fails.get(email.toLowerCase()) || []).filter((t) => now - t < WINDOW_MS);\n  fails.set(email.toLowerCase(), list);\n  return list.length < MAX_FAILS;\n}\n\nexport function failed(email, now = Date.now()) {\n  const key = email.toLowerCase();\n  fails.set(key, [...(fails.get(key) || []), now]);\n}\n";
const LIMIT_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { allowed, failed } from '../src/limit.js';\n\ntest('five failures within a minute lock the email', () => {\n  for (let i = 0; i < 5; i++) failed('sam@shop.test', 1000);\n  assert.equal(allowed('Sam@Shop.test', 2000), false);\n  assert.equal(allowed('sam@shop.test', 62000), true);\n});\n";
SCENARIOS.push({
  match: /failed sign-ins/i,
  steps: [
    { text: 'I will read how sign-in works first.', tools: [['read', { path: 'src/auth.js' }], ['read', { path: 'src/users.js' }]] },
    { text: '', tools: [['artifact', { kind: 'plan', title: 'Limit failed sign-ins', content: RUN_PLAN }]] },
    { text: 'The plan is ready: a small limiter in `src/limit.js`, checked by `login()`, with a test.' },
    { text: '', tools: [['write', { path: 'src/limit.js', content: LIMIT_JS }]] },
    { text: '', tools: [['edit', { path: 'src/auth.js', old_string: "import { findByEmail } from './users.js';", new_string: "import { findByEmail } from './users.js';\nimport { allowed, failed } from './limit.js';" }]] },
    { text: '', tools: [['edit', { path: 'src/auth.js', old_string: '  const user = findByEmail(email.trim());\n  if (!user || user.password !== `h4sh:${password}`) return null;', new_string: '  if (!allowed(email)) return null;\n  const user = findByEmail(email.trim());\n  if (!user || user.password !== `h4sh:${password}`) return (failed(email), null);' }]] },
    { text: '', tools: [['write', { path: 'test/limit.test.js', content: LIMIT_TEST }]] },
    { text: '', tools: [['artifact', { kind: 'tasks', title: 'Steps', content: '# Steps\n\n- [x] Read how sign-in works\n- [x] Add `src/limit.js`\n- [x] Check the limit in `login()`\n- [x] Add `test/limit.test.js`\n- [x] Run the tests\n' }]] },
    { text: '', tools: [['bash', { command: VISUAL ? CHECK : 'node --test test/limit.test.js' }]] },
    { text: '', tools: [['artifact', { kind: 'walkthrough', content: '# Walkthrough\n\n## What changed\n- `src/limit.js`: counts failed sign-ins per lower-cased email in a one-minute window; five failures lock the email.\n- `src/auth.js`: `login()` checks the limit first and records each wrong password.\n- `test/limit.test.js`: five failures lock the email, and it opens again after a minute.\n\n## Verification\n`node --test test/limit.test.js` passes: 1 test, 0 failures.\n' }]] },
    { text: 'Done. Five wrong passwords lock an email for a minute; the tests pass.' },
  ],
});

// Visual mode's "streaming" screen: the reply stops half way and the stream stays open until the end.
SCENARIOS.push({
  match: /health check endpoint/i,
  steps: [{ text: 'A health check needs no state of its own. I will add `GET /health`, which answers', hold: true }],
});

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
  const held = new Set();
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
      // (A held reply comes in one piece: ORBIX shows stream updates at most every 30 ms of its clock, which visual
      // mode stops, so only the first piece of a reply that never ends would show.)
      const words = (step.text || '').split(/(?<= )/);
      for (let i = 0; i < words.length; i += step.hold ? words.length : 6) {
        res.write(chunk({ delta: { content: words.slice(i, step.hold ? undefined : i + 6).join('') }, finish_reason: null }));
        await sleep(8);
      }
      if (step.hold) return held.add(res);
      (step.tools || []).forEach(([name, a], i) => {
        res.write(chunk({ delta: { tool_calls: [{ index: i, id: `call_${calls}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(a) } }] }, finish_reason: null }));
      });
      res.write(chunk({ delta: {}, finish_reason: step.tools?.length ? 'tool_calls' : 'stop' }));
      const prompt = 6000 + JSON.stringify(body.messages || []).length / 4;
      res.write(chunk(null, { usage: { prompt_tokens: Math.round(prompt), completion_tokens: 40 + Math.round((step.text || '').length / 4) } }));
      res.end('data: [DONE]\n\n');
    });
  });
  const close = server.close.bind(server);
  server.close = () => {
    for (const r of held) r.destroy();
    return close();
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ============================================================================ ORBIX

async function startOrbix(data, modelPort) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ version: 1, backend: { kind: 'native', distro: '' }, backendChosen: true, ui: { theme: THEME, rightPanel: true, rightTab: 'files', showThinking: true, autoScroll: true } }, null, 2));
  fs.writeFileSync(path.join(data, 'engine.json'), JSON.stringify({
    approvals: 'edits',
    trusted: ['node --test', 'npm test'],
    providers: { custom: { enabled: true, baseUrl: `http://127.0.0.1:${modelPort}/v1`, models: 1 } },
    defaultModel: `custom/${MODEL}`,
    verify: VISUAL ? 'always' : 'off', // visual: the run's Test log tab
    review: false,
  }, null, 2));
  const log = fs.openSync(path.join(data, 'orbix.out.log'), 'a');
  // ORBIX's own start-up (src/app.mjs) in a separate Node process, so the sample data folder is the only one it sees.
  const start = `${VISUAL ? clockSource(true) : ''} const { startOrbix } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'app.mjs')).href)}); await startOrbix({ port: 47990 });`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', start], { cwd: ROOT, env: { ...process.env, ...GIT_DATES, ...(VISUAL ? { TZ: 'UTC', LANG: 'en_US.UTF-8' } : {}), ORBIX_DATA: data }, stdio: ['ignore', log, log], windowsHide: true });
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
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', `--window-size=${VIEW.width},${VIEW.height}`,
    // Visual mode: software drawing in one pass, so the same page gives the same pixels every time.
    ...(VISUAL ? ['--disable-gpu', '--disable-gpu-compositing', '--disable-partial-raster', '--disable-skia-runtime-opts', '--run-all-compositor-stages-before-draw', '--disable-threaded-animation', '--disable-threaded-scrolling', '--disable-checker-imaging', '--disable-lcd-text', '--disable-font-subpixel-positioning'] : []),
    'about:blank'], { stdio: 'ignore', windowsHide: true });
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
  return { proc, cdp, dir, name: path.basename(exe) };
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
      const froms = ${JSON.stringify(tmpRoots())}, to = ${JSON.stringify(SHOWN_ROOT)};
      const has = (s) => froms.some((f) => s.includes(f));
      const fix = (s) => froms.reduce((a, f) => a.split(f).join(to), s);
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (has(n.data)) n.data = fix(n.data);
      for (const el of document.querySelectorAll('[title]')) if (has(el.title)) el.title = fix(el.title);`),
    /** Let pending work settle and draw: fonts, two frames, then a short pause. */
    async settle(ms = 400) {
      await P.eval('await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));');
      await sleep(ms);
    },
    /** `webp`: also write the website's WebP, at `webpDsf` when it is smaller than the PNG. */
    async capture(name, { dsf, webp = false, webpDsf = dsf, blur = VISUAL } = {}) {
      if (blur) await P.eval('document.activeElement?.blur?.()');
      await P.tidyPaths();
      await P.scale(dsf);
      await P.settle();
      let png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      // Visual mode: capture again until two captures in a row match, so a late update never lands in a baseline.
      for (let i = 0; VISUAL && i < 8; i++) {
        await P.settle(250);
        const again = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (again.data === png.data) break;
        png = again;
      }
      fs.writeFileSync(path.join(PNG_DIR, `${name}.png`), Buffer.from(png.data, 'base64'));
      if (webp) {
        // The full size, then the 1200 and 800 px wide copies the website's srcset lists.
        const sizes = [['', webpDsf], ['-1200', 1], ['-800', 2 / 3]].filter(([, d], i) => i === 0 || d < webpDsf);
        for (const [suffix, d] of sizes) {
          await P.scale(d);
          await P.settle();
          const w = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 82 });
          fs.writeFileSync(path.join(WEBP_DIR, `${name}${suffix}.webp`), Buffer.from(w.data, 'base64'));
        }
      }
      if (!VISUAL) say(`  ${name}.png${webp ? ` + ${name}.webp` : ''}`);
    },
  };
  return P;
}

// ============================================================================ scenes

const PROMPTS = {
  explain: 'Explain how this project is put together.',
  done: 'Customers cannot log in when their email has capital letters. Find out why and fix it.',
  approval: 'Password reset links expire after a minute instead of an hour. Fix it.',
  stream: 'Add a health check endpoint.',
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
  if (waitFor === 'stream') await page.until(`document.querySelector('.session:not([hidden]) .transcript')?.innerText.includes('which answers')`, 'the streaming reply').catch(async (e) => {
    const t = await page.eval(`return document.querySelector('.session:not([hidden]) .transcript')?.innerText.slice(-400) ?? 'no transcript'`).catch(() => null);
    throw new Error(`${e.message}: ${JSON.stringify(t)}`);
  });
  else if (waitFor === 'approval') await page.until(`document.querySelector('.approval') && ${tab}.dialogs.length`, 'the approval card');
  // The last message from the model (ORBIX may add its own after it, such as "Checks passed").
  else await page.until(`(${tab}) && !(${tab}).streaming && (${tab}).messages.filter((m) => m.role !== 'custom').at(-1)?.role === 'assistant' && (${tab}).messages.filter((m) => m.role !== 'custom').at(-1).content?.some?.((c) => c.type === 'text')`, `the "${key}" reply`).catch(async (e) => {
    const t = await page.eval(`const t = ${tab}; return t && { streaming: t.streaming, roles: t.messages.map((m) => m.role + (m.customType ? ':' + m.customType : '')) };`).catch(() => null);
    throw new Error(`${e.message}: ${JSON.stringify(t)}`);
  });
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
  await setTheme(page, THEME);

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

  await panel(true);
  await showPanelTab(page, 'Files');

  // Settings on Providers.
  await page.eval("(await import('/js/store.js')).emit('settings', 'engine')");
  await page.until("document.querySelector('.settings .pv-list .pv-card')", 'the providers page');
  await page.eval('document.activeElement?.blur()');
  await page.capture('settings', { dsf: 4 / 3, webp: true });
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.settle(300);

  // An edit waiting for approval: approvals switch to "ask first" for this one.
  await page.eval("const { api } = await import('/js/api.js'); await api.post('/api/engine/settings', { approvals: 'ask' }); await (await import('/js/store.js')).loadEngine();");
  // (It stays waiting: Home and the Review queue show it.)
  await converse(page, 'approval', { waitFor: 'approval' });

  // Home, with that approval waiting and the conversations so far.
  await page.eval("(await import('/js/store.js')).emit('home')");
  await page.until("document.querySelector('.home .home-composer') && document.querySelector('.home .home-status')", 'Home');
  await page.eval("document.querySelector('.welcome')?.scrollTo({ top: 0 })");
  await page.capture('home', { dsf: 4 / 3, webp: true });

  // A run: planned, approved, done in its own worktree, waiting for review.
  const runId = await page.eval(`const { api } = await import('/js/api.js'); const j = await api.post('/api/runs/start', { workspace: window.__shotProject, task: 'Limit failed sign-ins: lock an email for a minute after 5 wrong passwords.', mode: 'plan' }); return j.run.id;`);
  const runIs = (st) => `fetch('/api/runs', { headers: { 'x-orbix': '1' } }).then((r) => r.json()).then((j) => j.runs.find((x) => x.id === ${JSON.stringify(runId)})?.status === '${st}')`;
  await page.until(`await ${runIs('awaiting_plan')}`, 'the plan');
  await page.eval(`const { api } = await import('/js/api.js'); await api.post('/api/run/approve', { id: ${JSON.stringify(runId)}, commands: true, confirm: true });`);
  await page.until(`await ${runIs('review')}`, 'the finished run', 30000);
  await page.eval(`(await import('/js/runs.js')).openHub('run', ${JSON.stringify(runId)}); await new Promise((r) => setTimeout(r, 300));`);
  await page.until("document.querySelector('#runs .art-doc')?.innerText.includes('What changed')", 'the walkthrough');
  await page.capture('run', { dsf: 4 / 3, webp: true });
  await page.eval("[...document.querySelectorAll('#runs .run-tab')].find((b) => b.textContent.startsWith('Changes')).click()");
  await page.until("document.querySelectorAll('#runs .chg-file').length >= 3 && document.querySelector('#runs .chg-diff')?.innerText.includes('allowed')", 'the run diff');
  await page.capture('run-changes', { dsf: 4 / 3, webp: true });
  await page.eval("(await import('/js/runs.js')).openHub('review'); await new Promise((r) => setTimeout(r, 300));");
  await page.until("document.querySelector('#runs .rq-item')", 'the Review queue');
  await page.capture('review-queue', { dsf: 4 / 3, webp: true });

  // Loops: two scheduled prompts, one of them off.
  await page.eval(`const { api } = await import('/js/api.js');
    await api.post('/api/automations', { name: 'Morning test report', prompt: 'Run the tests and tell me what fails, with a fix for each.', project: window.__shotProject, schedule: { every: 'weekday', hour: 9, minute: 0 } });
    await api.post('/api/automations', { name: 'Weekly dependency check', prompt: 'List outdated dependencies and the risk of updating each one. Do not change files.', project: window.__shotProject, schedule: { every: 'week', day: 1, hour: 8, minute: 30 }, enabled: false });
    (await import('/js/runs.js')).openHub('automations'); await new Promise((r) => setTimeout(r, 300));`);
  await page.until("document.querySelectorAll('#runs .au-item').length === 2", 'the automations');
  await page.capture('automations', { dsf: 4 / 3, webp: true });

  // Plugins: the marketplace of MCP servers.
  await page.eval("(await import('/js/runs.js')).openHub('customizations'); await new Promise((r) => setTimeout(r, 300));");
  await page.until("document.querySelector('#runs .cz-sec')", 'the marketplace');
  await page.capture('customizations', { dsf: 4 / 3, webp: true });
}

// ============================================================================ main

// ============================================================================ visual regression test (--visual)

const VIS_THEMES = ['dark', 'light', 'graphite'];
const VIS_SCALES = [[1, '1x']]; // display scaling is covered by e2e/ui-stress.mjs (100-175%)
// Volatile pieces masked in every capture: the terminal runs a real shell, whose prompt and output are not ours.
// Animations end at once (on their last frame, and their end events still fire); nothing moves after that.
const VIS_STYLE = '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; scroll-behavior: auto !important; } .term-host > * { visibility: hidden !important; }';
const visualNames = [];
const audited = {}; // screen -> findings of tools/ui-audit.mjs

/** One screen in every theme and scale. `prep` runs after each theme change (and may reopen what it closed). */
async function vshot(page, name, prep = async () => {}) {
  if (ONLY && !ONLY.split(',').some((p) => name.startsWith(p))) return;
  for (const theme of VIS_THEMES) {
    // The sidebar's conversation list is read again every 30 s; read it now so a capture never has an older list.
    await page.eval("await (await import('/js/store.js')).loadSessions();");
    await setTheme(page, theme);
    await prep();
    if (AUDIT) {
      await page.settle();
      audited[`${name}-${theme}`] = await page.eval(inPage(auditPage));
    }
    for (const [dsf, tag] of VIS_SCALES) {
      const file = `${name}-${theme}-${tag}`;
      await page.capture(file, { dsf, blur: !prep.keepFocus });
      visualNames.push(file);
    }
    if (AUDIT && theme === 'dark' && /^(home|session|hub-|settings-look|panel-changes|model-picker|review)/.test(name)) audited[`${name}-${theme}-keys`] = await tabWalk(page);
  }
  say(`  ${name}`);
}

/** Tab through the screen like a keyboard user: every stop must be keyboard focus that shows. Returns audit findings. */
async function tabWalk(page) {
  const n = await page.eval(inPage(focusPrepare));
  const seen = new Set();
  const bad = [];
  let first = null;
  for (let i = 0; i < Math.min(n + 4, 90); i++) {
    await page.key('Tab', { code: 'Tab', keyCode: 9 });
    const r = await page.eval(inPage(focusProbe));
    if (!r) continue;
    if (first === null) first = r.key;
    else if (r.key === first && seen.size > 1) break;
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    if (!r.fv || !r.changed) bad.push({ k: 'focus', s: r.sel, v: r.fv ? 'focus does not show' : 'not keyboard focus', n: 1, t: r.label });
  }
  await page.eval('document.activeElement?.blur?.()');
  return bad;
}

const noLoading = (root) => `!document.querySelector('${root} .skel, ${root} .loading-state, ${root} .spin')`;

async function visualScenes(page, project, project2) {
  await page.eval(`const { api } = await import('/js/api.js');
    await api.post('/api/workspaces', { path: ${JSON.stringify(project)} });
    await api.post('/api/workspaces', { path: ${JSON.stringify(project2)} });`);
  await page.eval('location.reload()').catch(() => {});
  await sleep(500);
  await page.until("document.readyState === 'complete' && document.querySelector('.home .home-composer')", 'Home');
  await page.eval(`window.__shotProject = ${JSON.stringify(project)};`);
  await setTheme(page, 'dark');

  say('Conversations');
  await converse(page, 'explain');
  await page.eval(`const st = await import('/js/store.js'); await st.closeTab(window.__tabs.explain);`);
  await converse(page, 'done');
  await page.eval(`window.__shotProject = ${JSON.stringify(project2)};`);
  await converse(page, 'stream', { waitFor: 'stream' });
  await page.eval(`window.__shotProject = ${JSON.stringify(project)};`);
  await page.eval("const { api } = await import('/js/api.js'); await api.post('/api/engine/settings', { approvals: 'ask' }); await (await import('/js/store.js')).loadEngine();");
  await converse(page, 'approval', { waitFor: 'approval' });

  say('A run');
  const runId = await page.eval(`const { api } = await import('/js/api.js'); const j = await api.post('/api/runs/start', { workspace: window.__shotProject, task: 'Limit failed sign-ins: lock an email for a minute after 5 wrong passwords.', mode: 'plan' }); return j.run.id;`);
  const runIs = (st) => `fetch('/api/runs', { headers: { 'x-orbix': '1' } }).then((r) => r.json()).then((j) => j.runs.find((x) => x.id === ${JSON.stringify(runId)})?.status === '${st}')`;
  await page.until(`await ${runIs('awaiting_plan')}`, 'the plan');
  await page.eval(`const { api } = await import('/js/api.js'); await api.post('/api/run/approve', { id: ${JSON.stringify(runId)}, commands: true, confirm: true });`);
  await page.until(`await ${runIs('review')}`, 'the finished run', 30000);
  await page.settle(800);

  say('Screens');
  const st = "const st = await import('/js/store.js');";
  const wait = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;
  // From the top first: the offset at the end then never depends on where the transcript was before.
  const toEnd = "const tr = document.querySelector('.session:not([hidden]) .transcript'); if (tr) { tr.scrollTop = 0; tr.scrollTop = tr.scrollHeight; }";

  await page.eval(`${st} st.emit('home'); ${wait(300)}`);
  await page.until("document.querySelector('.home .home-composer') && document.querySelector('.home .home-status')", 'Home');
  await vshot(page, 'home', () => page.eval("document.querySelector('.welcome')?.scrollTo({ top: 0 })"));

  await page.eval(`${st} st.savePrefs({ rightPanel: false }); st.setActive(window.__tabs.done); ${wait(300)}`);
  await vshot(page, 'session-done', () => page.eval(toEnd));
  await page.eval(`${st} st.setActive(window.__tabs.stream); ${wait(300)}`);
  await vshot(page, 'session-streaming', () => page.eval(toEnd));
  await page.eval(`${st} st.setActive(window.__tabs.approval); ${wait(300)}`);
  await page.until("document.querySelector('.session:not([hidden]) .approval')", 'the approval card');
  await vshot(page, 'session-approval', () => page.eval(toEnd));

  // The right panel, each tab, next to the finished conversation.
  await page.eval(`${st} st.setActive(window.__tabs.done); st.savePrefs({ rightPanel: true }); ${wait(400)}`);
  for (const name of ['review', 'changes', 'files', 'console', 'browser', 'todos', 'run', 'ask', 'context', 'new']) {
    const shown = await page.eval(`const p = await import('/js/panels.js'); p.showTab(${JSON.stringify(name)}); ${wait(500)} return p.panelTab();`);
    if (shown !== name) {
      say(`  panel-${name}: not offered for this conversation (it has no worktree), skipped`);
      continue;
    }
    await page.settle(300);
    await vshot(page, `panel-${name}`, () => page.settle(200));
  }

  // The model picker, open on the conversation's model button.
  await page.eval(`${st} st.savePrefs({ rightPanel: false }); ${wait(300)}`);
  const openPicker = async () => {
    await page.eval(`if (!document.querySelector('.modal.model-picker')) { [...document.querySelectorAll('.session:not([hidden]) button[aria-haspopup="dialog"]')].find((b) => b.textContent.includes(${JSON.stringify(MODEL)}))?.click(); }`);
    await page.until(`document.querySelector('.model-picker') && ${noLoading('.model-picker')}`, 'the model picker').catch(async (e) => {
      const d = await page.eval(`return document.querySelector('.model-picker')?.outerHTML.slice(0, 1500) ?? 'no picker'`);
      throw new Error(`${e.message}: ${JSON.stringify(d)}`);
    });
    await page.settle(200);
  };
  await openPicker();
  openPicker.keepFocus = false;
  await vshot(page, 'model-picker', openPicker);
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.settle(300);

  // The Runs hub: its views, a run in each of its tabs, and the Review queue.
  // The hub shows when no conversation is in front: go Home first.
  await page.eval(`${st} st.emit('home'); ${wait(300)}`);
  for (const view of ['runs', 'automations', 'customizations', 'skills']) {
    await page.eval(`(await import('/js/runs.js')).openHub(${JSON.stringify(view)}); ${wait(400)}`);
    await page.until(noLoading('#runs'), `the ${view} view`, 30000);
    await vshot(page, `hub-${view}`, () => page.settle(200));
  }
  await page.eval(`(await import('/js/runs.js')).openHub('run', ${JSON.stringify(runId)}); ${wait(400)}`);
  await page.until("document.querySelector('#runs .run-tab')", 'the run');
  const runTabs = await page.eval("return [...document.querySelectorAll('#runs .run-tab')].map((b) => b.textContent.trim())");
  for (const label of ['Plan', 'Tasks', 'Changes', 'Test log', 'Walkthrough', 'Note']) {
    if (!runTabs.some((t) => t.startsWith(label))) continue;
    const click = () => page.eval(`[...document.querySelectorAll('#runs .run-tab')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click(); ${wait(300)}`);
    await click();
    await page.until(noLoading('#runs'), `the run's ${label} tab`);
    await vshot(page, `run-${label.toLowerCase().replace(/\s+/g, '-')}`, click);
  }
  await page.eval(`(await import('/js/runs.js')).openHub('review'); ${wait(400)}`);
  await page.until("document.querySelector('#runs .rq-item')", 'the Review queue');
  await vshot(page, 'review-queue', () => page.settle(200));
  await page.eval(`(await import('/js/runs.js')).closeHub(); ${wait(300)}`);

  // Settings, each page.
  const pages = ['general', 'behavior', 'network', 'look', 'notify', 'keys', 'engine', 'models', 'agents', 'tools', 'rules', 'checks', 'projects', 'worktrees', 'conversations', 'machines', 'browser', 'usage', 'feedback', 'application'];
  for (const key of pages) {
    const open = async () => {
      await page.eval(`${st} st.emit('settings', ${JSON.stringify(key)}); ${wait(300)}`);
      await page.until(`document.querySelector('.settings') && ${noLoading('.settings')}`, `the ${key} settings`, 30000);
      await page.eval("document.querySelector('.settings .set-main, .settings main')?.scrollTo?.({ top: 0 })");
      await page.settle(200);
    };
    await open();
    await vshot(page, `settings-${key}`, open);
  }
  await page.key('Escape', { code: 'Escape', keyCode: 27 });
  await page.settle(300);

  // The sidebar as a rail, next to the finished conversation.
  await page.eval(`${st} st.setActive(window.__tabs.done); st.savePrefs({ sideRail: true }); ${wait(400)}`);
  await page.until("document.querySelector('.app.side-rail')", 'the sidebar rail');
  await vshot(page, 'sidebar-rail', () => page.eval(toEnd));
  await page.eval(`${st} st.savePrefs({ sideRail: false });`).catch(() => {});
}

/** Compare the captures in `dir` with test/visual/, or save them there (approve). Returns the number of failures. */
/** Print what the audit found, one row per kind of finding with the screens it was on, and save it as JSON. */
function reportAudit() {
  const rows = summarize(audited);
  const file = path.join(os.tmpdir(), 'orbix-ui-audit.json');
  fs.writeFileSync(file, JSON.stringify({ size: VIEW, screens: Object.keys(audited).length, rows: rows.map((r) => ({ ...r, screens: [...r.screens] })) }, null, 1));
  const kinds = {};
  for (const r of rows) kinds[r.k] = (kinds[r.k] || 0) + 1;
  say(`Audit: ${Object.keys(audited).length} screens at ${VIEW.width}x${VIEW.height}, ${rows.length} findings (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`);
  for (const r of rows.slice(0, +(args[args.indexOf('--rows') + 1]) || 400)) say(`  ${r.k.padEnd(8)} ${String(r.screens.size).padStart(3)} screens  ${r.n} el  ${r.v}  ${r.s}${r.t ? `  "${r.t}"` : ''}`);
  say(`Full list: ${file}`);
  return rows.length && args.includes('--strict') ? 1 : 0;
}

function visualCompare(dir) {
  const diffDir = path.join(BASELINES, 'diff');
  fs.rmSync(diffDir, { recursive: true, force: true });
  fs.mkdirSync(BASELINES, { recursive: true });
  if (APPROVE) {
    for (const name of visualNames) fs.copyFileSync(path.join(dir, `${name}.png`), path.join(BASELINES, `${name}.png`));
    // Baselines of screens that are gone (only on a full run: --only takes some of them).
    let stale = 0;
    if (!ONLY) for (const f of fs.readdirSync(BASELINES)) if (f.endsWith('.png') && !visualNames.includes(f.slice(0, -4))) (fs.rmSync(path.join(BASELINES, f)), stale++);
    say(`Approved ${visualNames.length} baselines in ${path.relative(ROOT, BASELINES)}${stale ? `, removed ${stale} stale` : ''}`);
    return 0;
  }
  let failed = 0, worst = 0;
  for (const name of visualNames) {
    const base = path.join(BASELINES, `${name}.png`);
    if (!fs.existsSync(base)) {
      failed++;
      say(`  MISSING  ${name}.png (no baseline: run npm run visual:approve)`);
      continue;
    }
    const r = comparePixels(decodePng(fs.readFileSync(base)), decodePng(fs.readFileSync(path.join(dir, `${name}.png`))));
    const pct = r.sizeChanged ? 100 : (r.changed / r.total) * 100;
    worst = Math.max(worst, pct);
    if (r.changed || r.sizeChanged) {
      fs.mkdirSync(diffDir, { recursive: true });
      if (r.diff) fs.writeFileSync(path.join(diffDir, `${name}.png`), encodePng(r.diff));
      fs.copyFileSync(path.join(dir, `${name}.png`), path.join(diffDir, `${name}.actual.png`));
    }
    if (r.failed) {
      failed++;
      say(`  FAIL     ${name}.png  ${r.sizeChanged ? 'size changed' : `${r.changed} of ${r.total} pixels changed (${pct.toFixed(3)}%)`}`);
    } else if (r.changed) say(`  ok       ${name}.png  ${r.changed} pixels changed (${pct.toFixed(4)}%, under 0.1%)`);
  }
  const changed = fs.existsSync(diffDir) ? ` Diff images: ${path.relative(ROOT, diffDir)}` : '';
  say(failed ? `Visual test FAILED: ${failed} of ${visualNames.length} screens differ.${changed}` : `Visual test passed: ${visualNames.length} screens, largest change ${worst.toFixed(4)}%.${changed}`);
  return failed;
}

/**
 * Where visual mode keeps its sample projects. Under WSL that is Windows' temp folder: ORBIX (a Windows app) runs git
 * for Linux paths only through its WSL backend, so a project on the Windows drive is the one its git panels can read.
 */
function visualTmp() {
  if (process.platform === 'linux' && fs.existsSync('/mnt/c') && /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'))) {
    try {
      const win = execFileSync('cmd.exe', ['/d', '/c', 'echo %TEMP%'], { cwd: '/mnt/c', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const linux = execFileSync('wslpath', ['-u', win], { encoding: 'utf8' }).trim();
      if (fs.existsSync(linux)) return linux;
    } catch {}
  }
  return os.tmpdir();
}

// One visual run at a time per folder: a second run would empty the folder under the first one.
function takeVisualLock(file) {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      process.on('exit', () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); } catch {} });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (k) { alive = k.code === 'EPERM'; }
      if (alive) throw new Error(`Another visual run (process ${pid}) is using ${path.dirname(file)}. Wait for it to finish.`);
      fs.rmSync(file, { force: true }); // left by a run that ended without cleaning up
    }
  }
}

async function main() {
  // Visual mode: always the same folder, so every path (and anything derived from one) is the same on every run.
  // Under WSL the folder is on the Windows drive, so it gets its own name: a run from Windows never shares it.
  const tmp = VISUAL ? path.join(visualTmp(), process.platform === 'win32' ? 'orbix-visual' : 'orbix-visual-wsl') : fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-shots-'));
  if (VISUAL) {
    takeVisualLock(`${tmp}.lock`);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.mkdirSync(tmp, { recursive: true });
    PNG_DIR = path.join(tmp, 'captures');
  }
  tmpRoot = tmp;
  const project = path.join(tmp, 'shop-api');
  const project2 = path.join(tmp, 'billing-service');
  const data = path.join(tmp, 'data');
  makeProject(project);
  if (VISUAL) makeProject(project2);
  const model = await startModelServer();
  const orbix = await startOrbix(data, model.address().port);
  let browser = null;
  let failures = 0;
  const stop = async () => {
    try {
      browser?.cdp.close();
    } catch {}
    browser?.proc.kill();
    orbix.proc.kill();
    model.close();
    await sleep(800);
    if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (browser?.dir && !browser.dir.startsWith(tmp)) fs.rmSync(browser.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  try {
    // Visual mode keeps the browser's profile out of the fixed folder (under WSL, on the Windows drive): a profile
    // there can stay locked for a moment after the browser exits, and the next run must empty the folder.
    browser = await startBrowser(VISUAL ? fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-visual-browser-')) : path.join(tmp, 'browser'));
    const { cdp } = browser;
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
    // Still frames: no motion, so a capture never lands mid-animation.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'dark' }] });
    if (VISUAL) {
      await cdp.send('Page.setBypassCSP', { enabled: true }); // ORBIX's CSP would block the style below
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `${freezeClock}
        document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(VIS_STYLE)} })));` });
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
      await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    }
    const page = pageOf(cdp);
    await page.scale(1);
    await cdp.send('Page.navigate', { url: orbix.url });
    await page.until("document.readyState === 'complete' && document.querySelector('.app')", 'ORBIX to load');
    fs.mkdirSync(PNG_DIR, { recursive: true });
    if (!VISUAL) fs.mkdirSync(WEBP_DIR, { recursive: true });
    if (VISUAL) await visualScenes(page, project, project2);
    else await scenes(page, project);
    const errs = page.errors.filter(Boolean);
    if (errs.length) say(`Console errors:\n  ${errs.join('\n  ')}`);
    else say('Console: no errors');
    if (COMPARE) failures += visualCompare(PNG_DIR);
    if (AUDIT) failures += reportAudit();
  } finally {
    await stop();
  }
  if (VISUAL) {
    if (failures) process.exitCode = 1;
    return;
  }
  say(`Done. PNG: ${path.relative(ROOT, PNG_DIR)}  WebP: ${path.relative(ROOT, WEBP_DIR)}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
