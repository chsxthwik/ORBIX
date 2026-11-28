// A 2,000-message conversation: the timeline watches only the messages around the view and still follows the
// reader through far jumps, a click on a dot, the top and the bottom, and a switch to another conversation and
// back. Every message stays in the page (Find, copy and selection reach it). Headless browser, local fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, sleep, startBrowser, startModel, startOrbix, tmpRoot, writeConfig } from './lib.mjs';
import { seedConversation } from '../tools/seed-conversation.mjs';

const root = tmpRoot();
const repo = makeRepo(path.join(root, 'shop-api'));
const data = path.join(root, 'data');
const model = await startModel();
let app;
let page;
let passed = false;
try {
  writeConfig(data, model.port, [repo]);
  const seeded = seedConversation({ data, cwd: repo, messages: 2000 });
  app = await startOrbix(data, 47994);
  page = await startBrowser(path.join(root, 'browser'), { width: 1360, height: 860 });
  await page.goto(app.url);
  await page.until(`[...document.querySelectorAll('.sidebar button, .sidebar a')].some((b) => b.textContent.includes('A long conversation'))`, 'the seeded conversation in the sidebar');
  await page.eval(`[...document.querySelectorAll('.sidebar button, .sidebar a')].find((b) => b.textContent.includes('A long conversation')).click();`);
  await page.until(`document.querySelector('.session:not([hidden]) .tin > .msg')`, 'the transcript');
  // Older messages are drawn in the background: wait until their number stops growing and the heights are remembered.
  await page.eval(`const count = () => document.querySelectorAll('.session:not([hidden]) .tin > .msg').length;
    let last = -1; const t0 = performance.now();
    for (let n = count(); n !== last && performance.now() - t0 < 20000; n = count()) { last = n; await new Promise((r) => setTimeout(r, 500)); }
    for (let quiet = 0; quiet < 3 && performance.now() - t0 < 30000; ) { quiet = document.querySelector('.tin > .cv-measure') ? 0 : quiet + 1; await new Promise((r) => setTimeout(r, 150)); }`);
  const VIEW = `const view = document.querySelector('.session:not([hidden]) .session-inner')._view; const tl = view.timeline; const sc = view.scroller;`;
  // What the timeline says, and what is really on screen (measured here, in the test, with layout).
  const state = () => page.eval(`${VIEW}
    const box = sc.getBoundingClientRect();
    const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; };
    const turns = tl.marks.length;
    const current = tl.marks.findIndex((m) => m.button.getAttribute('aria-current') === 'true');
    const firstVisibleTurn = (() => { for (const el of tl.order) if (onScreen(el)) return tl.turnOf.get(el); return -1; })();
    return { messages: tl.order.length, turns, watched: tl.observed.size, seen: tl.seen.size, current, firstVisibleTurn, tabStops: tl.marks.filter((m) => m.button.tabIndex === 0).length,
      lit: tl.marks.filter((m) => m.button.classList.contains('seen')).length, top: Math.round(sc.scrollTop), height: sc.scrollHeight };`);
  const settled = async (what) => {
    let s;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      s = await state();
      if (s.seen > 0 && s.current === s.firstVisibleTurn) return s;
    }
    assert.fail(`${what}: the current dot (${s.current}) is not the first turn on screen (${s.firstVisibleTurn}); ${JSON.stringify(s)}`);
  };
  const few = (s, what) => assert.ok(s.watched > 0 && s.watched <= 120 && s.watched < s.messages / 8, `${what}: ${s.watched} of ${s.messages} messages watched`);

  let s = await settled('opened at the bottom');
  assert.ok(s.messages > 1200 && s.turns > 100, `a long conversation is in the page: ${s.messages} messages, ${s.turns} turns (seeded ${seeded.messages})`);
  few(s, 'at the bottom');
  assert.equal(s.tabStops, 1, 'one dot is the tab stop');
  assert.ok(s.lit >= 1 && s.lit < 20, `only the turns on screen are lit: ${s.lit}`);

  // A far jump, as Find or a dragged scrollbar makes: no watched message crosses the view on the way.
  await page.eval(`${VIEW} sc.scrollTop = Math.round(sc.scrollHeight / 2);`);
  s = await settled('after a jump to the middle');
  few(s, 'in the middle');
  assert.ok(s.current > 10 && s.current < s.turns - 10, `the middle of the conversation is current: turn ${s.current} of ${s.turns}`);

  await page.eval(`${VIEW} sc.scrollTop = 0;`);
  s = await settled('after a jump to the top');
  few(s, 'at the top');
  assert.equal(s.current, 0, 'the first turn is current at the top');

  // A click on a dot far from the view scrolls to that turn, and the strip follows.
  const target = Math.floor(s.turns * 0.7);
  await page.eval(`${VIEW} tl.marks[${target}].button.click();`);
  await page.until(`(() => { ${VIEW} const m = tl.marks[${target}]; const box = sc.getBoundingClientRect(); const r = m.target.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom && m.button.classList.contains('seen'); })()`, 'the clicked turn on screen and its dot lit', 8000);
  await sleep(700); // the smooth scroll ends
  s = await settled('after a click on a dot');
  few(s, 'after a click on a dot');
  assert.ok(Math.abs(s.current - target) <= 1, `the clicked turn (${target}) or the one above it is current: ${s.current}`);

  // Scrolling by hand (small steps) moves the watched range with the reader.
  const before = s.current;
  await page.eval(`${VIEW} for (let i = 0; i < 120; i++) { sc.scrollTop -= 90; await new Promise((r) => requestAnimationFrame(r)); }`);
  s = await settled('after scrolling up by hand');
  few(s, 'after scrolling by hand');
  assert.ok(s.current < before, `scrolling up moved the current turn back: ${before} → ${s.current}`);

  // Another conversation and back: the place is restored and the timeline finds it.
  const here = s.current;
  const place = () => page.eval(`${VIEW} const box = sc.getBoundingClientRect(); const i = tl.order.findIndex((e) => e.getBoundingClientRect().top >= box.top); return [i, Math.round(tl.order[i].getBoundingClientRect().top - box.top)];`);
  const was = await place();
  await page.eval(`const st = await import('/js/store.js'); window.__first = st.S.active; await st.openTab({ workspace: ${JSON.stringify(repo)} });`);
  await page.until(`document.querySelector('.session:not([hidden]) .composer textarea') && (await import('/js/store.js')).S.active !== window.__first`, 'a second conversation');
  await page.eval(`(await import('/js/store.js')).setActive(window.__first);`);
  await page.until(`document.querySelector('.session:not([hidden]) .session-inner')?._view?.timeline.order.length > 1200`, 'back in the long conversation');
  s = await settled('back from another conversation');
  const now = await place();
  assert.ok(now[0] === was[0] && Math.abs(now[1] - was[1]) <= 4, `the first message that starts in the view is the same one, at the same place: ${was} → ${now}`);
  assert.equal(s.current, here, 'the same turn is current after coming back');
  few(s, 'after coming back');

  // To the bottom again: the last turns are the ones lit.
  await page.eval(`${VIEW} sc.scrollTop = sc.scrollHeight;`);
  s = await settled('back at the bottom');
  assert.ok(s.current >= s.turns - 8 && await page.eval(`${VIEW} return tl.marks.at(-1).button.classList.contains('seen');`), `the last turns are lit at the bottom: current ${s.current} of ${s.turns}`);

  // Every message is still in the page: text far from the view can be found and selected.
  const reach = await page.eval(`${VIEW}
    const first = view.tin.querySelector(':scope > .msg.user .bubble');
    const range = document.createRange(); range.selectNodeContents(first);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    return { text: first.textContent.length, selected: String(sel).length, inPage: view.tin.textContent.length };`);
  assert.ok(reach.text > 0 && reach.selected === reach.text && reach.inPage > 100000, `far messages can be selected: ${JSON.stringify(reach)}`);
  assert.equal(page.errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length, 0, page.errors.join(' | '));
  console.log(`Long conversation: ${s.messages} messages, ${s.turns} turns; the timeline watches ${s.watched} of them and follows jumps, dots, hand scrolling and a conversation switch.`);
  passed = true;
} finally {
  page?.close();
  app?.proc.kill();
  model.server.close();
  if (passed) {
    await sleep(800);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } else console.error(`Kept the failed fixture: ${root}`);
}
