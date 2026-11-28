// Checks the Home composer and model picker in narrow and wide Windows layouts using a local fixture.
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
      assert.equal(page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length, 0);
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
