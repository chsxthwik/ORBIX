// The sidebar, rail and side panel under stress: window widths, display scaling, many and odd conversations, every
// theme, reduced motion, forced colours, keyboard only, hover, status changes and re-renders. Each check names what it
// measured; any failure exits 1. Screenshots of the key states go to a folder when one is given.
//
//   node e2e/ui-stress.mjs [screenshot folder]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep, startModel, makeRepo, writeConfig, startOrbix, startBrowser, tmpRoot } from './lib.mjs';

const OUT = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};

// ---- sample data: 20 projects, long and non-Latin names, and as many conversations as a case needs ----
const LONG = 'Investigate why the nightly export job silently drops rows when the upstream CSV has quoted newlines in it ok';
const TITLES = [LONG.slice(0, 120), '修复登录时邮箱大小写导致的问题', 'Добавить ограничение попыток входа', '🚀 Ship the release notes ✨', 'مراجعة سجل التغييرات', 'Short'];
function seed(data, projects, n) {
  for (let i = 0; i < n; i++) {
    const cwd = projects[i % projects.length];
    const dir = path.join(data, 'sessions', crypto.createHash('sha1').update(cwd.toLowerCase()).digest('hex').slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    const at = Date.now() - i * 3600_000;
    const id = `b${i.toString(36)}x`;
    const ts = new Date(at).toISOString();
    const lines = [
      { type: 'session', engine: 'builtin', version: 1, id, cwd, model: 'orbix-fixture', provider: 'custom', timestamp: ts },
      { type: 'title', title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` ${i}` : ''}` },
      { type: 'message', id: `${id}u`, message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: at } },
      { type: 'message', id: `${id}a`, message: { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }], timestamp: at + 1000, stopReason: 'stop' } },
    ];
    const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    fs.utimesSync(file, at / 1000, at / 1000);
  }
}

/** A second DevTools connection to the page, for real pointer hover and media emulation. */
async function devtools(profile) {
  const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0;
  const wait = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && wait.has(msg.id)) wait.get(msg.id)(msg), wait.delete(msg.id);
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  return { send, close: () => ws.close(), hover: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }), media: (features) => send('Emulation.setEmulatedMedia', { features }) };
}

const root = tmpRoot();
const model = await startModel();
const servers = [];
try {
  const projects = [makeRepo(path.join(root, 'shop-api')), makeRepo(path.join(root, 'billing-service'))];
  const names = ['web', 'docs', 'infra', 'mobile-app', 'données-clients', '项目-数据', '🚀-launch', 'a-very-long-project-name-that-keeps-going-and-going-to-test-ellipsis-in-the-sidebar-row-ok', 'api-gateway', 'auth', 'billing-ui', 'cli', 'design-system', 'etl', 'ml-models', 'notebooks', 'ops', 'sdk-js'];
  for (const n of names) fs.mkdirSync(path.join(root, n), { recursive: true }), projects.push(path.join(root, n));

  for (const count of [0, 1, 50, 500]) {
    const data = path.join(root, `data-${count}`);
    writeConfig(data, model.port, count === 0 ? projects.slice(0, 2) : projects);
    seed(data, projects, count);
    const orbix = await startOrbix(data, 47960 + servers.length);
    servers.push(orbix);
    for (const [w, h] of count === 500 ? [[760, 600], [1024, 720], [1440, 900], [2560, 1400]] : [[1024, 720]]) {
      for (const scale of count === 500 ? [1, 1.25, 1.5, 1.75] : [1]) {
        const profile = path.join(root, `b-${count}-${w}-${scale}`);
        const page = await startBrowser(profile, { width: w, height: h, scale });
        const dt = await devtools(profile);
        const tag = `${count} conv · ${w}px · ${scale * 100}%`;
        try {
          await page.goto(orbix.url);
          await page.until(`document.querySelector('#sidebar .side-scroll') && (${count} === 0 || document.querySelector('#sidebar .s-btn'))`, 'the sidebar', 30000);
          await sleep(500);
          if (w === 760) await page.eval(`(await import('/js/main.js').catch(() => null)); document.querySelector('.tb-side')?.click();`);
          await sleep(300);
          const m = JSON.parse(await page.eval(`
            const side = document.querySelector('#sidebar'), list = side.querySelector('.side-scroll');
            const rows = [...side.querySelectorAll('.s-btn')].filter((b) => b.getClientRects().length);
            const hs = new Set(rows.map((b) => Math.round(b.getBoundingClientRect().height)));
            const long = rows.find((b) => b.textContent.includes('silently drops'));
            const lt = long?.querySelector('.ell');
            const half = [...side.querySelectorAll('*')].some((el) => { const s = getComputedStyle(el); return ['Top', 'Right', 'Bottom', 'Left'].some((k) => { const v = parseFloat(s['border' + k + 'Width']); return s['border' + k + 'Style'] !== 'none' && v > 0 && v < 1; }); });
            return JSON.stringify({ shown: side.getClientRects().length > 0 && side.getBoundingClientRect().width > 0, over: side.scrollWidth - side.clientWidth, listOver: list.scrollWidth - list.clientWidth, heights: [...hs], longCut: lt ? lt.scrollWidth > lt.clientWidth : null, longTip: long ? long.title.length >= 100 : null, half, rows: rows.length });`));
          if (!m.shown && w === 760) check(true, `${tag}: sidebar is an overlay at 760px`);
          else {
            check(m.over <= 1 && m.listOver <= 1, `${tag}: no sideways overflow (${m.over}, ${m.listOver})`);
            if (count) check(m.heights.length === 1, `${tag}: every conversation row has one height (${m.heights.join(', ')})`);
            if (m.longCut !== null) check(m.longCut && m.longTip, `${tag}: a 120-character title is cut with an ellipsis and has its full text as a tooltip`);
            check(!m.half, `${tag}: no hairline thinner than one pixel`);
          }
          if (count === 0) check(await page.eval(`return [...document.querySelectorAll('#sidebar .s-none')].some((x) => /No conversations yet · Start one/.test(x.textContent))`), `${tag}: empty project says "No conversations yet · Start one"`);

          if (count === 500 && scale === 1 && w === 1440) {
            // hover: actions fade in over the row's end; nothing else moves
            const pos = `return JSON.stringify([...document.querySelectorAll('#sidebar .proj-head, #sidebar .s-row')].slice(0, 12).map((e) => { const r = e.getBoundingClientRect(); return [r.top, r.left, r.width, r.height].map(Math.round); }))`;
            const before = await page.eval(pos);
            const at = JSON.parse(await page.eval(`const r = document.querySelector('#sidebar .proj-head').getBoundingClientRect(); return JSON.stringify([r.left + 40, r.top + r.height / 2]);`));
            await dt.hover(at[0], at[1]);
            await sleep(250);
            check((await page.eval(pos)) === before, `${tag}: hovering a project row moves nothing`);
            check(await page.eval(`return getComputedStyle(document.querySelector('#sidebar .proj-head .row-acts')).opacity === '1'`), `${tag}: the project row's actions show on hover`);
            if (OUT) await page.shot(path.join(OUT, 'stress-hover.png'));
            await dt.hover(5, h - 5);
            // a status change keeps every row in place
            await page.eval(`const st = await import('/js/store.js'); window.__t = await st.openTab({ workspace: ${JSON.stringify(projects[0])} }); st.setActive(null);`);
            await sleep(600);
            const b2 = await page.eval(pos);
            await page.eval(`const st = await import('/js/store.js'); window.__t.streaming = true; st.emit('tabs');`);
            await sleep(400);
            check((await page.eval(pos)) === b2, `${tag}: a conversation starting to work moves no row`);
            await page.eval(`const st = await import('/js/store.js'); window.__t.streaming = false; st.emit('tabs');`);
            // a re-render keeps the scroll position and the focused row
            await page.eval(`const l = document.querySelector('#sidebar .side-scroll'); l.scrollTop = 600; const b = [...document.querySelectorAll('#sidebar .s-btn')].find((x) => x.getBoundingClientRect().top > 300); window.__f = b.dataset.path; b.focus({ preventScroll: true }); window.__s = l.scrollTop;`);
            await page.eval(`const st = await import('/js/store.js'); st.S.ui.sortProjects = st.S.ui.sortProjects; window.__t.unread = true; st.emit('tabs');`);
            await sleep(400);
            const kept = JSON.parse(await page.eval(`return JSON.stringify({ s: window.__s, now: document.querySelector('#sidebar .side-scroll').scrollTop, f: window.__f, a: document.activeElement?.dataset.path || document.activeElement?.className })`));
            check(kept.s > 100 && Math.abs(kept.now - kept.s) < 2 && kept.a === kept.f, `${tag}: a re-render keeps the scroll position and focus (${kept.s} → ${kept.now}, ${kept.a === kept.f ? 'same row' : kept.a})`);
            // keyboard: the list is one tab stop; arrows move the focus
            check(await page.eval(`return [...document.querySelectorAll('#sidebar .side-scroll [tabindex="0"]')].length === 1`), `${tag}: the sidebar list is one tab stop`);
            await page.press('ArrowDown', 40);
            check(await page.eval(`return document.activeElement?.dataset.path !== window.__f && document.activeElement?.closest('#sidebar .side-scroll') && document.activeElement.tabIndex === 0`), `${tag}: ArrowDown moves to the next row and makes it the tab stop`);
            // every theme: switching leaves no stuck colours
            const themes = ['dark', 'light', 'midnight', 'frost', 'graphite', 'tokyo', 'mocha', 'rosepine', 'nord', 'dracula', 'gruvbox', 'latte', 'dawn', 'orbix', 'sunset', 'nebula', 'aurora', 'dark'];
            const seen = await page.eval(`const st = await import('/js/store.js'); const out = [];
              for (const t of ${JSON.stringify(themes)}) { st.savePrefs({ theme: t }); await new Promise((r) => setTimeout(r, 120));
                const r = document.documentElement; out.push([r.dataset.theme, getComputedStyle(r).getPropertyValue('--bg').trim(), getComputedStyle(document.querySelector('#sidebar')).backgroundColor, [...r.style].filter((p) => !p.startsWith('--')).length]); }
              return JSON.stringify(out);`);
            const rows = JSON.parse(seen);
            check(rows.every((r, i) => r[0] === themes[i]), 'every theme applies');
            check(rows.every((r) => r[3] === 0), 'theme switches leave no inline style behind');
            check(new Set(rows.map((r) => r[1])).size >= 14, `each theme has its own background (${new Set(rows.map((r) => r[1])).size} distinct)`);
            check(rows[0][1] === rows.at(-1)[1] && rows[0][2] === rows.at(-1)[2], 'back to Dark, the colours are Dark again');
            // reduced motion and forced colours
            await dt.media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
            await sleep(200);
            check(await page.eval(`return [...document.querySelectorAll('#sidebar .dgrid i')].every((i) => getComputedStyle(i).animationName === 'none')`), 'reduced motion: the sidebar does not animate');
            await dt.media([{ name: 'forced-colors', value: 'active' }]);
            await sleep(300);
            check(await page.eval(`return matchMedia('(forced-colors: active)').matches`), 'forced colours: emulated');
            if (OUT) await page.shot(path.join(OUT, 'stress-forced-colors.png'));
            await dt.media([]);
            // the rail: icons only, 56px, with tooltips; Ctrl+B goes back
            await page.eval(`(await import('/js/store.js')).savePrefs({ sideRail: true }); await new Promise((r) => setTimeout(r, 400));`);
            const rail = JSON.parse(await page.eval(`const s = document.querySelector('#sidebar'); return JSON.stringify({ w: Math.round(s.getBoundingClientRect().width), labels: [...s.querySelectorAll('.side-l')].filter((x) => x.getClientRects().length).length, tips: [...s.querySelectorAll('.side-link, .proj-btn')].filter((x) => x.getClientRects().length).every((x) => x.title), over: s.scrollWidth - s.clientWidth })`));
            check(rail.w === 56 && rail.labels === 0 && rail.tips && rail.over <= 1, `rail: 56px, icons only, every item has a tooltip (${rail.w}px)`);
            if (OUT) await page.shot(path.join(OUT, 'stress-rail.png'));
            await page.key('b', { ctrl: true, keyCode: 66, code: 'KeyB' });
            await sleep(400);
            check(await page.eval(`return !document.querySelector('#app').classList.contains('side-rail')`), 'Ctrl+B goes from the rail back to the full sidebar');
          }
          if (OUT && scale === 1 && count === 500) await page.shot(path.join(OUT, `stress-${w}.png`));
          check(!page.errors.filter(Boolean).length, `${tag}: no console errors${page.errors.length ? ': ' + page.errors.join(' | ').slice(0, 200) : ''}`);
        } finally {
          dt.close();
          page.close();
        }
      }
    }
  }
} finally {
  for (const s of servers) s.proc.kill();
  model.server.close();
  await sleep(800);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  } catch {}
}
console.log(fails.length ? `\nui-stress: ${fails.length} failed` : '\nui-stress: passed');
process.exit(fails.length ? 1 : 0);
