#!/usr/bin/env node
// Smoke test the actual Electron window and its local engine on an isolated profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, makeRepo, sleep, startDesktop, startModel, tmpRoot, writeConfig } from './lib.mjs';

const tmp = tmpRoot();
const repo = makeRepo(path.join(tmp, 'project'));
const data = path.join(tmp, 'data');
const model = await startModel();
writeConfig(data, model.port, [repo]);
const mcp = path.join(tmp, 'mcp.mjs');
fs.writeFileSync(mcp, `import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  const result = method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : method === 'tools/list' ? { tools: [{ name: 'fixture_status', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } : {};
  if (id != null) console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
`);
const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
let page;
try {
  page = await startDesktop(exe, data, path.join(tmp, 'profile'), ROOT);
  await page.until(`document.querySelector('#sidebar .side-nav')`, 'sidebar');
  // Plugins, Skills, Loops and Review are the tabs of one Customize page; Runs has its own sidebar row.
  const open = async (name) => {
    if (name === 'Runs') return page.click(name, '#sidebar .side-nav');
    await page.click('Customize', '#sidebar .side-nav');
    await page.click(name, '.cust-tabs');
  };

  await open('Plugins');
  await page.until(`document.querySelector('.cz-item')`, 'visible Marketplace cards');
  assert.equal(await page.eval(`return !!document.querySelector('.cz-hero')`), false);
  await page.fill('input[aria-label="Search plugins"]', 'not-in-the-catalog');
  await page.until(`document.querySelector('.cz-none')?.textContent.includes('No plugins match')`, 'plugin search');
  await page.fill('input[aria-label="Search plugins"]', '');
  await page.click('Installed', '#runs');
  await page.click('Add custom server', '#runs');
  await page.fill('input[aria-label="Server name"]', 'fixture');
  await page.fill('textarea[aria-label="Server config (JSON)"]', JSON.stringify({ command: process.execPath, args: [mcp] }));
  await page.click('Save', '.mcp-edit');
  await page.until(`document.querySelector('#runs .card-h strong')?.textContent === 'fixture'`, 'persisted MCP server');
  await page.click('Disable', '#runs');
  await page.until(`document.querySelector('#runs .card-h')?.textContent.includes('Off')`, 'disabled MCP server');
  await page.click('Enable', '#runs');
  await page.until(`!document.querySelector('#runs .card-h')?.textContent.includes('Off')`, 'enabled MCP server');
  await page.click('Test', '#runs');
  await page.until(`document.querySelector('.mcp-out')?.textContent.includes('fixture_status')`, 'real connection and tool listing');
  const conflict = await page.eval(`
    const { api } = await import('/js/api.js');
    try {
      await api.post('/api/mcp/save', { name: 'fixture', createOnly: true, config: { url: 'http://127.0.0.1:1/mcp' } });
      return null;
    } catch (error) { return error.message; }
  `);
  assert.match(conflict, /already exists/);
  console.log('Plugins: catalog/search, save, disable/enable, connection and duplicate protection verified');

  await open('Skills');
  await page.click('New skill', '#runs');
  await page.fill('.sk-form input[aria-label="Name"]', 'release-notes');
  await page.fill('.sk-form input[aria-label="When to use it"]', 'Writing release notes');
  await page.fill('.sk-form textarea', 'Summarize local changes.');
  await page.click('Add skill', '.sk-form');
  await page.until(`document.querySelector('.sk-item')?.textContent.includes('release-notes')`, 'saved skill');
  await page.click('Use in new conversation', '#runs');
  await page.until(`document.querySelector('#welcome textarea')?.value.includes('/skill:release-notes')`, 'skill in new conversation');
  console.log('Skills: create and use in a project verified');

  await open('Loops');
  await page.click('Morning project brief', '#runs');
  await page.until(`document.querySelector('.au-form textarea')?.value.includes('local changes')`, 'template populated');
  await page.click('Add loop', '.au-form');
  await page.until(`document.querySelector('.au-item')?.textContent.includes('Morning project brief')`, 'loop saved');
  await page.click('Run now', '#runs');
  await page.until(`document.querySelector('.au-item')?.textContent.includes('Open latest')`, 'saved loop launches a conversation');
  await page.click('Open latest', '#runs');
  await page.until(`document.querySelector('#session')?.textContent.includes('Done.')`, 'the loop reply');
  assert.ok(model.seen.some((r) => r.last.includes('Summarize recent local changes')));

  await open('Runs');
  await page.until(`document.querySelector('.run-new')`, 'real run form');
  await page.fill('.run-new textarea', 'Sign-in fails for emails with capital letters. Fix it and add a test.');
  await page.click('Start run', '#runs');
  await page.until(`document.querySelector('#runs .run-decision')?.textContent.includes('Approve plan')`, 'run plan ready', 40000);
  await open('Runs');
  await page.until(`document.querySelector('#runs .rrow')?.textContent.includes('capital letters')`, 'the run appears in history');
  await page.fill('input[aria-label="Search runs"]', 'no-such-run');
  await page.until(`document.querySelector('.run-list')?.textContent.includes('No runs match')`, 'run history filter');
  await open('Review');
  await page.until(`document.querySelector('#runs .rq-head')?.textContent.includes('A plan is ready for your review')`, 'plan in Review queue');
  console.log('Loops, Runs and Review: template, real loop reply, plan, search and Review queue verified');

  await page.eval(`(await import('/js/store.js')).emit('settings', 'tools');`);
  await page.click('Open Plugins', '.settings-card');
  await page.until(`document.querySelector('.cz-tabs button[data-t=installed]')?.getAttribute('aria-pressed') === 'true'`, 'link to the MCP manager');
  await page.eval(`(await import('/js/store.js')).emit('settings', 'look');`);
  const scale = 'select[aria-label="Interface size"]';
  await page.until(`document.querySelector(${JSON.stringify(scale)})?.value === '1'`, 'unscaled default');
  const base = await page.eval('return devicePixelRatio;');
  await page.eval(`const s = document.querySelector(${JSON.stringify(scale)}); s.value = '0.8'; s.dispatchEvent(new Event('change'));`);
  await page.until(`Math.abs(devicePixelRatio / ${base} - 0.8) < 0.015`, '80% zoom applied');
  await page.eval(`document.querySelector(${JSON.stringify(scale)}).parentElement.querySelector('button').click();`);
  await page.until(`Math.abs(devicePixelRatio / ${base} - 1) < 0.015`, 'reset zoom applied');
  console.log('Settings: shortcut to Plugins, 80% resize and reset verified');
} finally {
  page?.close();
  model.server.close();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
