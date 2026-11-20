#!/usr/bin/env node
// Desktop end-to-end test of a conversation: start a task from Home, approve the edit and the command, and check
// that the finished turn reads as one "Worked for…" row above the reply, that the row opens to every step, and
// that the changed-files card works. Same fixtures as e2e/run.mjs.
//
//   node e2e/conversation.mjs [--keep] [--shots]
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startModel, makeRepo, writeConfig, startOrbix, startBrowser, tmpRoot } from './lib.mjs';

const args = process.argv.slice(2);
const SHOTS = args.includes('--shots');
const say = (s) => process.stdout.write(s + '\n');
const assert = (c, what) => {
  if (!c) throw new Error(`Expected: ${what}`);
};

const root = tmpRoot();
const data = path.join(root, 'data');
const repo = makeRepo(path.join(root, 'shop api ñ'));
const model = await startModel();
writeConfig(data, model.port, [repo]);
const orbix = await startOrbix(data, 47992);
const page = await startBrowser(path.join(root, 'browser'), { scale: 2 });
const shot = (n) => (SHOTS ? page.shot(path.join(ROOT, 'docs', 'evidence', `${n}.png`)) : null);
let ok = false;
try {
  await page.goto(orbix.url);
  await page.until(`document.querySelector('#welcome textarea')`, 'Home');
  await page.fill('#welcome textarea', 'Explain sign-in and fix it for mixed-case emails.');
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  // The edit asks first (approvals are on): the approval card, then Allow once. The check command asks too.
  for (let i = 0; i < 2; i++) {
    await page.until(`document.querySelector('.approval .btn.primary')`, 'an approval');
    await page.click('Allow once', '.approval');
  }
  await page.until(`document.querySelector('details.work .work-l')?.textContent.startsWith('Worked for')`, 'the folded turn', 40000);
  await shot('12-conversation-folded');
  const info = await page.eval(`
    const f = document.querySelector('details.work');
    const facts = f.querySelector('.work-facts').innerText;
    const reply = f.nextElementSibling;
    return { open: f.open, facts, tools: f.querySelectorAll('.tool[data-id]').length, replyText: reply?.innerText || '', replyCls: reply?.className || '', by: f.previousElementSibling?.classList.contains('asst-by'), order: [...f.parentNode.children].map((x) => x.tagName.toLowerCase() + '.' + [...x.classList].join('.')).join(' | '), sum: document.querySelector('.turn-sum')?.innerText || '' };`);
  assert(!info.open, 'the steps folded when the turn finished');
  assert(/Read 2 files/.test(info.facts) && /1 search/.test(info.facts) && /Ran 1 command/.test(info.facts) && /Changed 1 file/.test(info.facts), `the facts in the fold (${info.facts})`);
  assert(info.tools === 6, `the five steps and the passed check inside the fold (${info.tools})`);
  assert(!/Read 2 files/.test(info.sum), 'the steps are summed up once (in the fold), not again on the changed-files card');
  assert(info.by, 'the agent name above the fold');
  assert(info.replyCls.includes('msg') && info.replyText.includes('keyed by lower-case email'), `the final reply right below the fold (${info.order})`);
  assert(info.sum.includes('1 file changed') && info.sum.includes('Review'), 'the changed-files card');
  await page.eval(`document.querySelector('details.work > summary').click()`);
  await page.until(`document.querySelector('details.work').open && [...document.querySelectorAll('details.work .tool[data-id]')].every((x) => x.offsetParent)`, 'the steps shown');
  await shot('13-conversation-steps');
  const bad = page.errors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
  assert(!bad.length, `no page errors: ${bad.join(' | ')}`);
  ok = true;
  say('conversation e2e: passed');
} catch (e) {
  say(`conversation e2e: FAILED — ${e.message}\nKept: ${root}`);
} finally {
  page.close();
  orbix.proc.kill();
  model.server.close();
  if (ok) setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 }); } catch {} }, 600);
}
setTimeout(() => process.exit(ok ? 0 : 1), 900);
