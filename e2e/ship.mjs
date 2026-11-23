#!/usr/bin/env node
// The Changes panel's ship path in the real interface: the changed files with +/- counts, an inline diff on click, a
// message the model writes, and Commit & push (Ctrl+Enter) to a remote, ending in a pull request link. The remote is
// a local bare repository; the address the link is built from is a GitHub one (set as the fetch address while pushes
// go to the folder).
//
//   node e2e/ship.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { sleep, startModel, makeRepo, git, writeConfig, startOrbix, startBrowser, tmpRoot } from './lib.mjs';

const KEEP = process.argv.includes('--keep');
const say = (s) => process.stdout.write(`${s}\n`);
const assert = (c, what) => {
  if (!c) throw new Error(`Expected: ${what}`);
};

const root = tmpRoot();
const data = path.join(root, 'data');
const repo = makeRepo(path.join(root, 'shop api'));
const bare = path.join(root, 'origin.git');
fs.mkdirSync(bare);
git(bare, 'init', '-q', '--bare', '-b', 'main');
git(repo, 'checkout', '-q', '-b', 'orbix/ship-test');
git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop-api.git');
git(repo, 'config', 'remote.origin.pushurl', bare);
fs.appendFileSync(path.join(repo, 'src', 'auth.js'), '\n// rate limit\nexport const LIMIT = 5;\n');
fs.writeFileSync(path.join(repo, 'src', 'limit.js'), 'export function allowed() {\n  return true;\n}\n');

const model = await startModel();
writeConfig(data, model.port, [repo]);
const orbix = await startOrbix(data, 47995);
const page = await startBrowser(path.join(root, 'browser'), { width: 1360, height: 860 });
let ok = false;
try {
  await page.goto(orbix.url);
  await page.until(`document.querySelector('#welcome textarea')`, 'Home');
  await page.eval(`const st = await import('/js/store.js'); await st.openTab({ workspace: ${JSON.stringify(repo)} }); (await import('/js/panels.js')).showTab('changes');`);
  await page.until(`document.querySelectorAll('.gfile').length === 2`, 'two changed files');
  await page.until(`[...document.querySelectorAll('.gfile')].every((r) => /[+-]\\d/.test(r.textContent))`, 'every changed file to show its +/- count');
  assert(await page.eval(`return document.querySelector('.gfile').textContent.includes('+3')`), 'src/auth.js shows +3');
  say('ship e2e: changed files with +/- counts');

  await page.eval(`document.querySelector('.gfile').click()`);
  await page.until(`document.querySelector('.gdiff .dl.add')`, 'the inline diff');
  assert(await page.eval(`return document.querySelector('.gdiff').textContent.includes('rate limit')`), 'the diff shows the added lines');
  say('ship e2e: inline diff on click');

  // The model writes the message (the scripted model answers a short text; whatever it says becomes the message).
  await page.click('Write', '.commit-box');
  await page.until(`document.querySelector('.commit-msg').value.trim().length > 0`, 'a written message', 90000);
  say('ship e2e: Write fills the message');

  await page.fill('.commit-msg', 'Lock an email after 5 failed sign-ins\n\nAdds `src/limit.js` and the limit in `src/auth.js`.');
  await page.eval(`document.querySelector('.commit-msg').focus()`);
  await page.key('Enter', { ctrl: true, keyCode: 13, code: 'Enter' });
  await page.until(`document.querySelector('.ship')?.textContent.includes('Pushed orbix/ship-test to origin')`, 'the push', 90000);
  assert(await page.eval(`return document.querySelector('.ship').textContent.includes('Committed') && document.querySelector('.ship').textContent.includes('Lock an email after 5 failed sign-ins')`), 'the note names the commit');
  const link = await page.eval(`return document.querySelector('.ship-link')?.getAttribute('href') || ''`);
  assert(link.startsWith('https://github.com/acme/shop-api/compare/main...orbix%2Fship-test?'), `the pull request link points at the branch (${link.slice(0, 90)})`);
  const q = new URL(link).searchParams;
  assert(q.get('quick_pull') === '1' && q.get('title') === 'Lock an email after 5 failed sign-ins' && q.get('body').includes('src/limit.js'), 'the link carries the title and body');
  say('ship e2e: Ctrl+Enter commits, pushes and links the pull request');

  assert(git(bare, 'log', '-1', '--format=%s', 'orbix/ship-test').trim() === 'Lock an email after 5 failed sign-ins', 'the remote has the commit');
  assert(git(repo, 'status', '--porcelain').trim() === '', 'the working tree is clean');
  await page.until(`document.querySelectorAll('.gfile').length === 0`, 'the panel shows a clean tree');
  say('ship e2e: the remote has the commit and the panel is clean');

  const bad = page.errors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
  assert(!bad.length, `no page errors: ${bad.join(' | ')}`);
  ok = true;
  say('ship e2e: passed');
} catch (e) {
  say(`ship e2e: FAILED — ${e.message}\nKept: ${root}`);
} finally {
  page?.close();
  orbix?.proc.kill();
  model.server.close();
}
if (ok && !KEEP) {
  await sleep(800);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (e) {
    say(`Note: could not remove ${root} (${e.code}); delete it later.`);
  }
}
process.exit(ok ? 0 : 1);
