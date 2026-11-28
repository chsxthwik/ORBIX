#!/usr/bin/env node
// Profile ORBIX on a long conversation. No dependencies.
//
//   node tools/perf.mjs [--messages 2000] [--runs 3] [--json out.json] [--profile] [--electron] [--throttle 4] [--keep]
//
// --electron measures the Windows app itself (Electron from node_modules, or ORBIX_ELECTRON), with the engine in its
// own process as users run it. Without it a headless browser opens the ORBIX server: Chromium is the cleanest there,
// as Edge and Brave inject page scripts of their own that show up in the numbers.
//
// --throttle N slows the page's CPU N times (DevTools CPU throttling), to see a slower PC: on a fast one the scroll
// test sits at the display's 60 fps and hides differences. --profile adds a CPU profiler, which itself slows the
// page a lot: use it to see where time goes, not for the numbers.
//
// It seeds a conversation of --messages messages (tools/seed-conversation.mjs) into a temporary data folder, starts
// ORBIX on it with a scripted local model, opens it in a headless Chromium browser (Edge, Chrome, Brave or Chromium;
// ORBIX_BROWSER picks one) and measures, as the median of --runs:
//
//   open    ms from the click on the conversation in the sidebar to its transcript painted
//   scroll  frames per second while the transcript scrolls from the bottom to the top, and the slowest frame
//   memory  JS heap after a garbage collection, and the number of DOM nodes, with the conversation open
//   ttft    ms from Enter to the first token of the reply painted, while the model streams it
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT, makeRepo, writeConfig, startOrbix, startBrowser, startDesktop, killTree, sleep } from '../e2e/lib.mjs';
import { seedConversation } from './seed-conversation.mjs';

const args = process.argv.slice(2);
const arg = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const MESSAGES = Number(arg('messages', 2000));
const RUNS = Math.max(1, Number(arg('runs', 3)));
const KEEP = args.includes('--keep');
const ELECTRON = args.includes('--electron');
const THROTTLE = Math.max(1, Number(arg('throttle', 1)));
const MARK = 'STREAM-START';
// Windows slows or stops the frames of a window that is covered or in the background. The measurement must not
// depend on what else is on the screen, so the app under test keeps drawing as if it were in front.
const AWAKE = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];
const say = (s) => process.stdout.write(s + '\n');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** An OpenAI-compatible model that streams a long Markdown reply in small pieces, the first one at once. */
function startModel() {
  const reply = [`${MARK} The reply starts here.`, ...Array.from({ length: 60 }, (_, i) => (i % 15 === 14 ? '\n\n```js\nconst x = ' + i + ';\n```\n\n' : ` Sentence ${i} of the streamed answer, with \`code\` and **bold** text.${i % 5 === 4 ? '\n\n' : ''}`))];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'orbix-fixture', object: 'model' }] }));
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
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Summary.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
      }
      const chunk = (choice, extra = {}) => `data: ${JSON.stringify({ id: 'perf', object: 'chat.completion.chunk', model: 'orbix-fixture', choices: choice ? [{ index: 0, ...choice }] : [], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ delta: { role: 'assistant' }, finish_reason: null }));
      for (const piece of reply) {
        res.write(chunk({ delta: { content: piece }, finish_reason: null }));
        await sleep(12);
      }
      res.write(chunk({ delta: {}, finish_reason: 'stop' }));
      res.write(chunk(null, { usage: { prompt_tokens: 12000, completion_tokens: 900 } }));
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- the measurements, run in the page ----

const OPEN = `
  const row = [...document.querySelectorAll('.sidebar button, .sidebar a')].find((b) => b.textContent.includes('A long conversation'));
  if (!row) throw new Error('the seeded conversation is not in the sidebar');
  const t0 = performance.now();
  row.click();
  const visible = () => document.querySelector('.session:not([hidden]) .tin > .msg');
  while (!visible()) await new Promise((r) => setTimeout(r, 4));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { ms: performance.now() - t0, rendered: document.querySelectorAll('.session:not([hidden]) .tin .msg').length };
`;

const SCROLL = `
  const sc = document.querySelector('.session:not([hidden]) .transcript');
  sc.scrollTop = sc.scrollHeight;
  await new Promise((r) => setTimeout(r, 300));
  const frames = [];
  let last = performance.now();
  const start = last;
  // About 3 screens a second, the speed of a quick wheel or trackpad flick, for up to 5 seconds or to the top.
  await new Promise((done) => {
    const step = (now) => {
      frames.push(now - last);
      last = now;
      sc.scrollTop -= 45;
      if (sc.scrollTop <= 0 || now - start > 5000) return done();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  frames.shift();
  const total = frames.reduce((a, b) => a + b, 0);
  const sorted = [...frames].sort((a, b) => a - b);
  // Frames per second on a 60 Hz display: a frame that takes longer than 16.7 ms holds the screen for the vsyncs it
  // missed. (A headless browser runs frames faster than 60 Hz, so a raw count would overstate it.)
  const vsyncs = frames.reduce((n, f) => n + Math.max(1, Math.ceil(f / (1000 / 60) - 0.05)), 0);
  return { fps: 60 * frames.length / vsyncs, worst: sorted.at(-1), p95: sorted[Math.floor(sorted.length * 0.95)], frames: frames.length, dropped: frames.filter((f) => f > 1000 / 60 + 0.5).length, height: sc.scrollHeight };
`;

const TTFT = `
  const view = document.querySelector('.session:not([hidden])');
  const ta = view.querySelector('textarea');
  ta.focus();
  ta.value = 'Measure the first token, please.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const long = [];
  const po = new PerformanceObserver((l) => long.push(...l.getEntries().map((e) => e.duration)));
  try { po.observe({ type: 'longtask', buffered: false }); } catch {}
  let t0 = 0;
  const first = new Promise((resolve) => {
    const seen = () => [...view.querySelectorAll('.tin .msg.asst')].some((m) => m.textContent.includes('${MARK}'));
    const mo = new MutationObserver(() => {
      if (!seen()) return;
      mo.disconnect();
      requestAnimationFrame(() => resolve(performance.now()));
    });
    mo.observe(view.querySelector('.tin'), { childList: true, subtree: true, characterData: true });
  });
  t0 = performance.now();
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  const t1 = await first;
  // Then wait for the reply to finish, so the next run starts from rest.
  const t2 = performance.now();
  while (view.querySelector('.tin .msg.asst.live') || view.querySelector('.send.stop')) {
    if (performance.now() - t2 > 20000) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  po.disconnect();
  return { ms: t1 - t0, longTasks: long.length, longest: Math.max(0, ...long) };
`;

/** With --profile: the functions that took the most time (self time) while `fn` ran. */
async function profiled(page, label, fn) {
  if (!args.includes('--profile')) return fn();
  // Where the main thread's time went: the browser's own counters for script, style and layout.
  await page.cdp.send('Performance.enable');
  const counters = async () => Object.fromEntries((await page.cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  const before = await counters();
  const r0 = await profiledCpu(page, label, fn);
  const after = await counters();
  const d = (k) => ((after[k] - before[k]) * 1000).toFixed(0);
  say(`  ${label}: script ${d('ScriptDuration')} ms, style ${d('RecalcStyleDuration')} ms (${after.RecalcStyleCount - before.RecalcStyleCount}×), layout ${d('LayoutDuration')} ms (${after.LayoutCount - before.LayoutCount}×), all tasks ${d('TaskDuration')} ms`);
  return r0;
}

async function profiledCpu(page, label, fn) {
  await page.cdp.send('Profiler.enable');
  await page.cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await page.cdp.send('Profiler.start');
  const r = await fn();
  const { profile } = await page.cdp.send('Profiler.stop');
  const self = new Map();
  const dt = (profile.endTime - profile.startTime) / 1000 / Math.max(1, profile.samples.length);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const id of profile.samples) {
    const cf = byId.get(id).callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + dt);
  }
  const top = [...self].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12);
  say(`  ${label}, top self time:`);
  for (const [k, ms] of top) say(`    ${ms.toFixed(1).padStart(7)} ms  ${k}`);
  return r;
}

async function memory(page) {
  await page.cdp.send('HeapProfiler.enable');
  await page.cdp.send('HeapProfiler.collectGarbage');
  await page.cdp.send('Performance.enable');
  const { metrics } = await page.cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { heapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-perf-'));
  const data = path.join(tmp, 'data');
  const project = path.join(tmp, 'shop-api');
  fs.mkdirSync(project, { recursive: true });
  makeRepo(project);
  const model = await startModel();
  writeConfig(data, model.address().port, [project]);
  const seeded = seedConversation({ data, cwd: project, messages: MESSAGES });
  say(`Seeded ${seeded.messages} messages.`);
  const orbix = ELECTRON ? null : await startOrbix(data, 47993);
  const electron = process.env.ORBIX_ELECTRON || path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const results = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      const page = ELECTRON ? await startDesktop(electron, data, path.join(tmp, `profile-${run}`), ROOT, AWAKE) : await startBrowser(path.join(tmp, `browser-${run}`));
      try {
        if (!ELECTRON) await page.goto(orbix.url);
        await page.until(`[...document.querySelectorAll('.sidebar button, .sidebar a')].some((b) => b.textContent.includes('A long conversation'))`, 'the seeded conversation in the sidebar');
        await sleep(500);
        if (THROTTLE > 1) await page.cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
        const open = await profiled(page, 'open', () => page.eval(OPEN));
        // Older messages are drawn in the background after the first paint: wait until all of them are in the page.
        const all = await page.eval(`
          const count = () => document.querySelectorAll('.session:not([hidden]) .tin .msg').length;
          const t0 = performance.now();
          let last = -1;
          for (let n = count(); n !== last && performance.now() - t0 < 10000; n = count()) {
            last = n;
            await new Promise((r) => setTimeout(r, 400));
          }
          const ms = performance.now() - t0 - 400;
          // Then until the idle work after it (remembering message heights) is done, so it does not run during the scroll test.
          for (let quiet = 0; quiet < 3 && performance.now() - t0 < 20000; ) {
            quiet = document.querySelector('.tin > .cv-measure') ? 0 : quiet + 1;
            await new Promise((r) => setTimeout(r, 150));
          }
          return { rendered: last, ms };
        `);
        open.rendered = all.rendered;
        open.allMs = open.ms + all.ms;
        await sleep(500);
        const mem = await memory(page);
        let scroll = await profiled(page, 'scroll', () => page.eval(SCROLL));
        if (!scroll.frames) scroll = await page.eval(SCROLL); // the transcript was not ready to scroll yet: once more
        await page.eval(`document.querySelector('.session:not([hidden]) .transcript').scrollTop = 1e9; await new Promise((r) => setTimeout(r, 300));`);
        const ttft = await profiled(page, 'first token', () => page.eval(TTFT));
        results.push({ open, mem, scroll, ttft });
        say(`run ${run + 1}: open ${open.ms.toFixed(0)} ms (all ${open.rendered} drawn by ${open.allMs.toFixed(0)} ms) · scroll ${scroll.fps.toFixed(1)} fps, worst ${scroll.worst.toFixed(1)} ms, ${scroll.dropped} over 16.7 ms of ${scroll.frames} · heap ${mem.heapMB.toFixed(1)} MB, ${mem.nodes} nodes · first token ${ttft.ms.toFixed(0)} ms (${ttft.longTasks} long tasks, longest ${ttft.longest.toFixed(0)} ms)`);
        if (page.errors.length) say(`  page errors: ${page.errors.slice(0, 3).join(' | ')}`);
      } finally {
        page.close();
      }
    }
  } finally {
    if (orbix) killTree(orbix.proc);
    model.close();
    if (!KEEP) {
      await sleep(500); // the browsers let go of their profile folders
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        say(`Could not remove ${tmp} entirely; delete it by hand.`);
      }
    }
    else say(`Kept ${tmp}`);
  }
  const pick = (f) => median(results.map(f));
  const summary = {
    messages: seeded.messages,
    openMs: pick((r) => r.open.ms),
    rendered: pick((r) => r.open.rendered),
    allDrawnMs: pick((r) => r.open.allMs),
    scrollFps: pick((r) => r.scroll.fps),
    scrollWorstMs: pick((r) => r.scroll.worst),
    scrollSlowFrames: pick((r) => r.scroll.dropped),
    heapMB: pick((r) => r.mem.heapMB),
    domNodes: pick((r) => r.mem.nodes),
    ttftMs: pick((r) => r.ttft.ms),
    streamLongTasks: pick((r) => r.ttft.longTasks),
  };
  say('\nMedian of ' + RUNS + ' runs:');
  say(`  open        ${summary.openMs.toFixed(0)} ms to the first paint; all ${summary.rendered} messages in the page by ${summary.allDrawnMs.toFixed(0)} ms`);
  say(`  scroll      ${summary.scrollFps.toFixed(1)} fps at 60 Hz, slowest frame ${summary.scrollWorstMs.toFixed(1)} ms, ${summary.scrollSlowFrames} frames over 16.7 ms`);
  say(`  memory      ${summary.heapMB.toFixed(1)} MB JS heap, ${summary.domNodes} DOM nodes`);
  say(`  first token ${summary.ttftMs.toFixed(0)} ms (${summary.streamLongTasks} long tasks while streaming)`);
  const out = arg('json');
  if (out) fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
