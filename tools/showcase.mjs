#!/usr/bin/env node
// Framed images for the README: each real screen from docs/img/shots (made by `node tools/shots.mjs --theme graphite`)
// on the website's near-black ground and dot field, with a mono label, bleeding off the bottom edge. No dependencies:
// a headless Chromium (Microsoft Edge, Chrome, Brave or Chromium, or the one named by ORBIX_BROWSER) renders a small
// page per image, driven over the DevTools protocol.
//
//   node tools/showcase.mjs           write docs/img/showcase/<name>.png for every screen listed below
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'img', 'shots');
const OUT = path.join(ROOT, 'docs', 'img', 'showcase');
const W = 1600, H = 1000;

// name → the label in the corner.
const SCREENS = {
  done: 'Conversations',
  run: 'Runs',
  'run-changes': 'Changes',
  'review-queue': 'Review',
  home: 'Home',
  automations: 'Loops',
  customizations: 'Plugins and skills',
};

function browser() {
  const env = process.env.ORBIX_BROWSER;
  if (env && fs.existsSync(env)) return env;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', la = process.env.LOCALAPPDATA || '';
  const list = process.platform === 'win32'
    ? [`${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${la}\\Google\\Chrome\\Application\\chrome.exe`, `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`]
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge'];
  const hit = list.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('No Chromium browser found; set ORBIX_BROWSER to one.');
  return hit;
}

const url = (p) => pathToFileURL(p).href;
const page = (shot, label) => `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: M; src: url("${url(path.join(ROOT, 'site', 'assets', 'fonts', 'geist-mono-latin-wght-normal.woff2'))}"); }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #070807; }
canvas { position: absolute; inset: 0; }
.k { position: absolute; left: 80px; top: 44px; display: flex; align-items: center; gap: 12px; color: #A4ACA7; font: 400 20px/1 M; letter-spacing: -.01em; }
.k i { width: 10px; height: 10px; background: #3DF28C; }
.k b { color: #E8ECE9; font-weight: 500; }
.f { position: absolute; left: 80px; right: 80px; top: 100px; overflow: hidden; border: 1px solid rgba(232, 240, 235, .16); border-bottom: 0; border-radius: 14px 14px 0 0; background: #0B0D0C; box-shadow: 0 40px 120px -30px rgba(0, 0, 0, .9); }
.f::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(61, 242, 140, .55), transparent); }
.f img { display: block; width: 100%; }
.fade { position: absolute; left: 0; right: 0; bottom: 0; height: 140px; background: linear-gradient(to bottom, rgba(7, 8, 7, 0), #070807); }
</style></head><body><canvas id="c" width="${W}" height="${H}"></canvas>
<div class="k"><i></i><b>ORBIX</b> ${label}</div>
<div class="f"><img src="${url(shot)}"></div><div class="fade"></div>
<script>
const x = document.getElementById('c').getContext('2d'), S = 12, t = 3.7;
for (let j = 0; j * S < ${H}; j++) for (let i = 0; i * S < ${W}; i++) {
  const X = i * S, Y = j * S;
  const v = Math.sin(X * .011 + t * .55) + Math.sin(Y * .017 - t * .42) + Math.sin((X - Y) * .006 + t * .3) + Math.sin(Math.hypot(X - ${W} * .8, Y - ${H} * .2) * .018 - t * .9);
  const n = (v / 4 + .5) * Math.min(1, Y / 420 + X / ${W} * .6);
  if (n < .34) continue;
  x.fillStyle = n > .78 && (i * 7 + j * 13) % 4 === 0 ? 'rgba(61,242,140,.85)' : 'rgba(232,240,235,' + (.06 + (n - .34) * .45) + ')';
  x.fillRect(X, Y, 2, 2);
}
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start the browser and return a DevTools session on its page. */
async function open(exe, dir) {
  const root = process.platform !== 'win32' && process.getuid?.() === 0; // Chromium refuses to run as root without it
  const proc = spawn(exe, ['--headless=new', ...(root ? ['--no-sandbox'] : []), '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { await sleep(100); }
  }
  if (!port) { proc.kill(); throw new Error('The browser did not start.'); }
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d.result); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  return { send, close: () => { try { ws.close(); } catch {} proc.kill(); } };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-showcase-'));
fs.mkdirSync(OUT, { recursive: true });
const cdp = await open(browser(), path.join(tmp, 'profile'));
try {
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const [name, label] of Object.entries(SCREENS)) {
    const shot = path.join(SHOTS, `${name}.png`);
    if (!fs.existsSync(shot)) { console.log(`  skipped ${name}: no ${path.relative(ROOT, shot)}`); continue; }
    const html = path.join(tmp, `${name}.html`);
    fs.writeFileSync(html, page(shot, label));
    await cdp.send('Page.navigate', { url: url(html) });
    for (let i = 0; i < 50; i++) {
      const r = await cdp.send('Runtime.evaluate', { expression: "document.readyState === 'complete' && document.fonts.status === 'loaded' && document.querySelector('img').complete", returnByValue: true });
      if (r?.result?.value) break;
      await sleep(100);
    }
    const png = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    const out = path.join(OUT, `${name}.png`);
    fs.writeFileSync(out, Buffer.from(png.data, 'base64'));
    console.log(`  ${path.relative(ROOT, out)}`);
  }
} finally {
  cdp.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
