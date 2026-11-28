// Checks the Home composer, the model picker and the context panel (both meters, and its error state) in narrow and
// wide Windows layouts at 2× DPI, using a local fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, sleep, startBrowser, startModel, startOrbix, tmpRoot, writeConfig } from './lib.mjs';

const root = tmpRoot();
const repo = makeRepo(path.join(root, 'viewport fixture'));
const data = path.join(root, 'data');
const model = await startModel();
let app;
let passed = false;
try {
  writeConfig(data, model.port, [repo]);
  app = await startOrbix(data, 47993);
  for (const [width, height] of [[760, 540], [1800, 1024]]) {
    const page = await startBrowser(path.join(root, `browser-${width}`), { width, height, scale: 2 });
    try {
      await page.goto(app.url);
      await page.until(`document.documentElement.dataset.mode === 'dark' && !!document.querySelector('.home-composer textarea')`, 'the composer');
      const fits = `const fits = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      };`;
      const composer = await page.eval(`${fits}
        const box = document.querySelector('.home-composer'), send = box.querySelector('.send');
        return { fits: fits(box) && fits(send), box: box.getBoundingClientRect().toJSON(), send: send.getBoundingClientRect().toJSON() };`);
      assert(composer.fits, `the composer and send button stay in the viewport: ${JSON.stringify(composer)}`);
      await page.click('Model for the new conversation', '#welcome');
      await page.until(`document.querySelector('.mp-list [role=option]')`, 'model results');
      assert(await page.eval(`${fits} return fits(document.querySelector('.model-picker')) && fits(document.querySelector('.mp-footer'));`), 'the picker and its controls fit without horizontal clipping');
      await page.press('Escape', 27);
      // The context panel, from the toolbar meter and from the message box, stays inside the window.
      await page.eval(`const st = await import('/js/store.js'); window.__tab = await st.openTab({ workspace: ${JSON.stringify(repo)} }); await st.sendPrompt(window.__tab, 'Say hello.');`);
      await page.until(`!window.__tab.streaming && window.__tab.messages.some((m) => m.role === 'assistant')`, 'a reply');
      for (const meter of ['.tb-ctx', '.session:not([hidden]) .c-ctx']) {
        await page.until(`document.querySelector(${JSON.stringify(meter)})?.textContent.includes('%')`, `the meter ${meter}`);
        await page.mouse(meter);
        await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-rows li')`, 'the context breakdown');
        assert(await page.eval(`${fits} const p = document.querySelector('.menu.cx-pop:not(.leaving)'); return fits(p) && fits(p.querySelector('.cx-foot')) && fits(document.querySelector(${JSON.stringify(meter)}));`), `the context panel from ${meter} fits the window`);
        await page.press('Escape', 27);
        await page.until(`!document.querySelector('.menu.cx-pop:not(.leaving)')`, 'the panel closed');
      }
      // A failed read says so and can be retried; nothing stale is shown in its place.
      await page.eval(`window.__fetch = window.fetch; window.fetch = (url, init) => String(init?.body || '').includes('get_context_budget') ? Promise.reject(new Error('offline')) : window.__fetch(url, init); window.__tab.stats = null;`);
      await page.mouse('.tb-ctx');
      await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .errbox')?.textContent.includes('Couldn’t read context usage.')`, 'the error state');
      assert.deepEqual(await page.eval(`${fits} const p = document.querySelector('.menu.cx-pop:not(.leaving)'); return [fits(p), !!p.querySelector('.cx-rows'), [...p.querySelectorAll('button')].find((b) => /Compact/.test(b.textContent)).disabled];`), [true, false, true]);
      await page.eval(`window.fetch = window.__fetch;`);
      await page.click('Retry', '.menu.cx-pop:not(.leaving)');
      await page.until(`document.querySelector('.menu.cx-pop:not(.leaving) .cx-rows li') && !document.querySelector('.menu.cx-pop:not(.leaving) .errbox')`, 'the numbers after Retry');
      await page.press('Escape', 27);
      // Close the conversation, so the next window size starts on Home again.
      await page.eval(`await (await import('/js/store.js')).closeTab(window.__tab.id);`);
      await page.until(`!(await import('/js/store.js')).S.tabs.size`, 'the conversation closed');
      assert.equal(page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length, 0, page.errors.join(' | '));
      console.log(`${width} × ${height}, Dark, 2× DPI: passed`);
    } finally {
      page.close();
    }
  }
  passed = true;
} finally {
  app?.proc.kill();
  model.server.close();
  if (passed) {
    await sleep(800);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } else console.error(`Kept the failed fixture: ${root}`);
}
