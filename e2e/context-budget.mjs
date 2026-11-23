// Windows Electron: check real provider usage responses, the warning colors, and the Compact now action.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { MODEL, ROOT, makeRepo, sleep, startDesktop, tmpRoot, writeConfig } from './lib.mjs';

const tmp = tmpRoot();
const data = path.join(tmp, 'data');
const project = makeRepo(path.join(tmp, 'shop'));
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') return res.setHeader('content-type', 'application/json').end(JSON.stringify({ data: [{ id: MODEL }] }));
  let raw = '';
  for await (const part of req) raw += part;
  const { messages } = JSON.parse(raw);
  const last = String(messages.at(-1)?.content || '');
  const input = last.includes('amber fixture') ? 102360 : last.includes('critical fixture') ? 121560 : 1200;
  const text = last.includes('<conversation>') ? 'Earlier project notes were reviewed.' : 'Fixture reply.';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ choices: [], usage: { prompt_tokens: input, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 400 }, cost: 0.0123 } });
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
  await open();
  await send('amber fixture', 1);
  await page.until(`document.querySelector('.tb-ctx.hot')?.textContent.includes('80%')`, 'amber at exactly 80%');
  await page.mouse('.tb-ctx');
  await page.until(`document.querySelector('.ctx-popover .ctx-pop-list')`, 'usage rows');
  assert.match(await page.text('.ctx-popover'), /102,360 input, 40 output/);
  assert.match(await page.text('.ctx-popover'), /\$0\.0123/);
  assert.equal(await page.eval(`return [...document.querySelectorAll('.ctx-popover button')].find(b => b.textContent === 'Compact now').disabled`), true);
  await page.press('Escape', 27);
  await page.until(`document.querySelector('.tb-ctx')?.getAttribute('aria-expanded') === 'false'`, 'Escape closes the popover');
  await open();
  for (let i = 1; i <= 6; i++) {
    await send(i === 1 ? `Earlier context: ${'project details. '.repeat(500)}` : `Keep turn ${i} verbatim.`, i);
  }
  await send('critical fixture: keep this latest message.', 7);
  await page.until(`document.querySelector('.tb-ctx.crit')?.textContent.includes('95%')`, 'red at exactly 95%');
  await page.mouse('.tb-ctx');
  await page.until(`document.querySelector('.ctx-popover .ctx-pop-list')`, 'critical context breakdown');
  const rows = await page.text('.ctx-pop-list');
  for (const label of ['System prompt', 'Project rules', 'Files attached', 'Conversation history', 'Tool results']) assert.ok(rows.includes(label));
  await page.click('Compact now', '.ctx-popover');
  await page.until(`document.querySelector('.ctx-pop-outcome')?.textContent.includes('tokens saved')`, 'tokens saved in the popover');
  await page.until(`document.querySelector('.ctx-pop-cost')?.textContent.includes('$0.0984')`, 'summary cost reflected in the session');
  assert.ok(await page.eval(`return window.__contextTab.messages.some(m => m.role === 'user' && m.content[0].text === 'critical fixture: keep this latest message.')`));
  console.log('Electron: 80% amber, 95% red, five buckets, reported usage, running cost, compact savings and latest message verified.');
} catch (e) {
  if (page) console.error(await page.eval(`return {
    meter: document.querySelector('.tb-ctx')?.textContent,
    window: window.__contextTab?.stats?.contextUsage,
    lastError: window.__contextTab?.messages.at(-1)?.errorMessage,
  };`).catch(() => null), page.errors);
  throw e;
} finally {
  page?.close();
  server.close();
  await sleep(700);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
