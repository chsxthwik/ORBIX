// Windows Electron: the context meter in the toolbar and in the message box, and the one panel both open. Checks
// real provider usage responses, the warning colours, small and unknown values, the keyboard, a conversation switch
// while the panel loads, and Compact now.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MODEL, ROOT, makeRepo, sleep, startDesktop, tmpRoot, writeConfig } from './lib.mjs';

const tmp = tmpRoot();
const data = path.join(tmp, 'data');
const project = makeRepo(path.join(tmp, 'shop'));
let release = null;
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') return res.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ id: MODEL }] }));
  let raw = '';
  for await (const part of req) raw += part;
  const { messages } = JSON.parse(raw);
  const last = String(messages.at(-1)?.content || '');
  const input = last.includes('amber fixture') ? 102360 : last.includes('critical fixture') ? 121560 : last.includes('small fixture') ? 472 : 1200;
  const text = last.includes('<conversation>') ? 'Earlier project notes were reviewed.' : 'Fixture reply.';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  if (last.includes('held fixture')) await new Promise((resolve) => (release = resolve));
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  // "small fixture": a provider that reports tokens and no price.
  send({ choices: [], usage: { prompt_tokens: input, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 400 }, ...(last.includes('small fixture') ? {} : { cost: 0.0123 }) } });
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
writeConfig(data, server.address().port, [project]);
let page;
try {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  page = await startDesktop(exe, data, path.join(tmp, 'profile'), ROOT);
  await page.until(`document.querySelector('#sidebar .side-nav')`, 'sidebar');
  const open = () => page.eval(`const st = await import('/js/store.js'); window.__contextTab = await st.openTab({ workspace: ${JSON.stringify(project)} });`);
  const send = async (text, replies) => {
    await page.eval(`await (await import('/js/store.js')).sendPrompt(window.__contextTab, ${JSON.stringify(text)});`);
    await page.until(`!window.__contextTab.streaming && window.__contextTab.messages.filter(m => m.role === 'assistant').length === ${replies}`, 'provider reply settled');
  };
  const TOOLBAR = '.tb-ctx';
  const BOX = '.session:not([hidden]) .c-ctx';
  const panel = (what) => page.eval(`const p = document.querySelector('.menu.cx-pop:not(.leaving)'); if (!p) return null; ${what}`);
  const rows = () => page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-rows li')`, 'the breakdown');
  const closed = () => page.until(`!document.querySelector('.menu.cx-pop:not(.leaving)')`, 'the panel closed');

  // ---- a small context: a real value under 1%, an honest ring, and a cost the provider did not report
  await open();
  await send('small fixture', 1);
  await page.until(`document.querySelector(${JSON.stringify(TOOLBAR)})?.textContent === '0.4%'`, '512 of 128,000 tokens reads 0.4%, not 0% or <1%');
  assert.equal(await page.eval(`return document.querySelector(${JSON.stringify(BOX)}).textContent`), '0.4%', 'the message box shows the same value');
  const arc = await page.eval(`return document.querySelector(${JSON.stringify(TOOLBAR)} + ' .ring-arc').getAttribute('stroke-dasharray').split(' ').map(Number)`);
  assert.ok(arc[0] / arc[1] < 0.01, `the ring is not padded up: ${arc}`);
  await page.mouse(TOOLBAR);
  await rows();
  assert.match(await panel(`return p.querySelector('.cx-cost').textContent`), /Session cost\s*Not reported/);
  assert.match(await panel(`return p.querySelector('.cx-src').textContent`), /^Reported by the provider/);
  assert.equal(await panel(`return p.querySelector('.cx-badge').textContent`), '0.4% used');
  // The parts of the bar are their true share of the window: together they cover what the badge says.
  const widths = await panel(`const bar = p.querySelector('.cx-seg'); return { parts: [...bar.children].map((i) => parseFloat(i.style.width)), order: [...p.querySelector('.cx-main').children, ...p.querySelectorAll('.cx-foot > *')].map((e) => e.className.split(' ')[0]) };`);
  assert.ok(Math.abs(widths.parts.reduce((a, b) => a + b, 0) - 0.4) < 0.05, `segments add up to the share used: ${widths.parts}`);
  assert.deepEqual(widths.order.filter((c) => c !== 'grow'), ['cx-use', 'cx-seg', 'cx-parts', 'cx-stats', 'cx-link', 'btn'], 'usage and limit, breakdown, cost, Details, Compact');
  await page.press('Escape', 27);
  await closed();

  // ---- amber: both entry points open the same panel with the same numbers
  await open();
  await send('amber fixture', 1);
  await page.until(`document.querySelector('.tb-ctx.hot')?.textContent === '80%'`, 'amber at exactly 80%');
  await page.until(`document.querySelector(${JSON.stringify(BOX)} + '.hot')?.textContent === '80%'`, 'the message box meter is amber too');
  const seen = {};
  for (const [name, sel] of [['toolbar', TOOLBAR], ['box', BOX]]) {
    await page.mouse(sel);
    await rows();
    assert.equal(await page.eval(`return document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-expanded')`), 'true');
    assert.equal(await page.eval(`return document.querySelectorAll('.menu.cx-pop:not(.leaving)').length`), 1, 'one panel at a time');
    assert.ok(await page.eval(`return document.activeElement === document.querySelector('.menu.cx-pop:not(.leaving) .cx-title')`), 'focus moves into the panel');
    const text = await page.text('.menu.cx-pop:not(.leaving)');
    assert.match(text, /102,360 input, 40 output/);
    assert.match(text, /\$0\.0123/);
    assert.match(text, /80% used/);
    seen[name] = text;
    assert.ok(await panel(`const r = p.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;`), `the panel from the ${name} stays on screen`);
    // Tab stays inside the panel and wraps; Escape closes it and gives the focus back to the meter that opened it.
    const stops = await panel(`return p.querySelectorAll('button:not(:disabled)').length`);
    const visited = new Set();
    for (let i = 0; i < stops + 2; i++) {
      await page.press('Tab', 9);
      visited.add(await page.eval(`const a = document.activeElement; return a?.closest('.menu.cx-pop') ? a.textContent : 'OUTSIDE'`));
    }
    assert.ok(!visited.has('OUTSIDE') && visited.size === stops, `Tab cycles the panel's ${stops} controls: ${[...visited]}`);
    await page.press('Escape', 27);
    await closed();
    assert.equal(await page.eval(`return document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-expanded')`), 'false');
    assert.ok(await page.eval(`return document.activeElement === document.querySelector(${JSON.stringify(sel)})`), `Escape returns the focus to the ${name} meter`);
  }
  assert.equal(seen.toolbar, seen.box, 'the toolbar and the message box show one panel');
  // Opening from the other meter moves the panel; clicking the same meter again closes it.
  await page.mouse(TOOLBAR);
  await rows();
  await page.mouse(BOX);
  await rows();
  assert.equal(await page.eval(`return [document.querySelector(${JSON.stringify(TOOLBAR)}).getAttribute('aria-expanded'), document.querySelector(${JSON.stringify(BOX)}).getAttribute('aria-expanded')].join()`), 'false,true');
  await page.mouse(BOX);
  await closed();

  // ---- busy: Compact is off with the reason in words, and the numbers refresh when the turn ends
  await page.eval(`(await import('/js/store.js')).sendPrompt(window.__contextTab, 'held fixture');`);
  await page.until(`window.__contextTab.streaming && !!document.querySelector('.session:not([hidden]) .send.stop')`, 'the agent working');
  await page.mouse(BOX);
  await rows();
  assert.deepEqual(await panel(`const b = [...p.querySelectorAll('button')].find((x) => /Compact/.test(x.textContent)); return [b.disabled, document.getElementById(b.getAttribute('aria-describedby')).textContent];`), [true, 'Wait for the agent to finish first.']);
  for (let i = 0; i < 40 && !release; i++) await sleep(100);
  release();
  await page.until(`!window.__contextTab.streaming`, 'the held turn finished');
  await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-cost')?.textContent.includes('$0.0369')`, 'the open panel picks up the cost of the turn and of the automatic compaction before it');

  // ---- a conversation switch while the panel is open closes it; its late answer is dropped
  const first = await page.eval(`return window.__contextTab.id`);
  await open();
  await closed();
  await page.until(`document.querySelector(${JSON.stringify(TOOLBAR)}) && !document.querySelector(${JSON.stringify(TOOLBAR)}).hidden`, 'the toolbar meter of the new conversation');
  await page.mouse(TOOLBAR);
  await page.eval(`(await import('/js/store.js')).setActive(${JSON.stringify(first)});`);
  await closed();
  await sleep(600); // the answer for the conversation left behind arrives now: it must not reopen or redraw anything
  assert.equal(await page.eval(`return document.querySelectorAll('.menu.cx-pop').length + document.querySelectorAll('.ctx-meter[aria-expanded=true]').length`), 0, 'no panel after the switch');
  assert.equal(await page.eval(`return document.querySelector(${JSON.stringify(TOOLBAR)}).textContent`), '0.9%', 'the toolbar meter follows the conversation shown');

  // ---- red, the measured parts, and Compact now from the toolbar
  await open();
  for (let i = 1; i <= 6; i++) {
    await send(i === 1 ? `Earlier context: ${'project details. '.repeat(500)}` : `Keep turn ${i} verbatim.`, i);
  }
  await send('critical fixture: keep this latest message.', 7);
  await page.until(`document.querySelector('.tb-ctx.crit')?.textContent === '95%'`, 'red at exactly 95%');
  await page.mouse(TOOLBAR);
  await rows();
  const parts = await page.text('.menu.cx-pop:not(.leaving) .cx-rows');
  for (const label of ['System prompt', 'Tool definitions', 'Conversation history']) assert.ok(parts.includes(label), label);
  for (const label of ['Project rules', 'Files attached', 'Tool results']) assert.ok(!parts.includes(label), label);
  assert.match(await page.text('.menu.cx-pop:not(.leaving) .cx-warn'), /Almost full/);
  await page.press('Escape', 27);
  await closed();
  await page.mouse(BOX);
  await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-rows')?.textContent.includes('Conversation history')`, 'the same breakdown from the message box');
  await page.click('Compact now', '.menu.cx-pop:not(.leaving)');
  await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-note.ok')?.textContent.includes('tokens saved')`, 'tokens saved in the panel');
  await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-cost')?.textContent.includes('$0.0984')`, 'the summary cost reflected in the session');
  await page.until(`!document.querySelector('.tb-ctx.crit')`, 'the meters drop after compaction');
  assert.ok(await page.eval(`return window.__contextTab.messages.some(m => m.role === 'user' && m.content[0].text === 'critical fixture: keep this latest message.')`));
  assert.equal(page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length, 0, page.errors.join(' | '));
  console.log('Electron: both context meters, one panel, small and unreported values, keyboard and focus, busy and switch states, cost and compaction verified.');
} catch (e) {
  if (page) console.error(await page.eval(`return {
    meter: document.querySelector('.tb-ctx')?.textContent,
    box: document.querySelector('.session:not([hidden]) .c-ctx')?.textContent,
    panel: document.querySelector('.menu.cx-pop')?.innerText,
    window: window.__contextTab?.stats?.contextUsage,
    lastError: window.__contextTab?.messages.at(-1)?.errorMessage,
  };`).catch(() => null), page.errors);
  throw e;
} finally {
  release?.();
  page?.close();
  server.close();
  await sleep(700);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
