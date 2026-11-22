#!/usr/bin/env node
// Desktop end-to-end test of a conversation: start a task from Home, approve the edit and the command, and check
// that the finished turn reads as one "Worked for…" row above the reply, that the row opens to every step, and
// that the changed-files card works. Same fixtures as e2e/run.mjs.
//
//   node e2e/conversation.mjs [--keep] [--shots] [--desktop]
// --desktop uses the unpacked Windows executable from npm run dist instead of a standalone browser.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startModel, makeRepo, writeConfig, startOrbix, startBrowser, startDesktop, tmpRoot } from './lib.mjs';

const args = process.argv.slice(2);
const SHOTS = args.includes('--shots');
const DESKTOP = args.includes('--desktop');
const KEEP = args.includes('--keep');
const say = (s) => process.stdout.write(s + '\n');
const assert = (c, what) => {
  if (!c) throw new Error(`Expected: ${what}`);
};

const root = tmpRoot();
const data = path.join(root, 'data');
const repo = makeRepo(path.join(root, 'shop api ñ'));
const model = await startModel();
writeConfig(data, model.port, [repo]);
const shot = (n) => (SHOTS ? page.shot(path.join(ROOT, 'docs', 'evidence', `${n}.png`)) : null);
let orbix;
let page;
let ok = false;
try {
  if (DESKTOP) {
    page = await startDesktop(process.env.ORBIX_DESKTOP_EXE || path.join(ROOT, 'dist', 'win-unpacked', 'ORBIX.exe'), data, path.join(root, 'desktop'));
    await page.until(`!!window.orbixDesktop`, 'the Electron preload bridge', 20000);
    assert(await page.eval(`return location.href.startsWith('orbix://app/') && !!window.orbixDesktop.engine`), 'the interface from orbix://app/ with the engine over IPC');
    say('desktop e2e: running the packaged ORBIX window');
  } else {
    orbix = await startOrbix(data, 47992);
    page = await startBrowser(path.join(root, 'browser'), { scale: 2 });
    await page.goto(orbix.url);
  }
  await page.until(`document.querySelector('#welcome textarea')`, 'Home');
  assert(await page.eval(`return !(await import('/js/api.js')).recentCalls.includes('/api/engine')`), 'boot gets provider status in the initial state response');
  await page.eval(`const trigger = document.querySelector('.home-model-pick'); trigger.focus(); trigger.click();`);
  await page.until(`document.querySelector('.mp-rail .mp-pv') && document.querySelector('.mp-list')?.textContent.includes('orbix-fixture')`, 'the Home provider and model');
  assert(await page.eval(`return (await import('/js/api.js')).recentCalls.includes('/api/engine/models') && !(await import('/js/api.js')).recentCalls.includes('/api/proc/start')`), 'Home lists models directly and starts no temporary agent');
  await page.until(`document.activeElement?.matches('.model-picker input[role=combobox]')`, 'model search receives focus');
  await page.press('ArrowDown', 40);
  assert(await page.eval(`
    const q = document.activeElement;
    const row = document.getElementById(q.getAttribute('aria-activedescendant'));
    return row?.textContent.includes('orbix-fixture') && row.tabIndex === -1 && document.querySelector('#app').inert;
  `), 'one focus target tracks keyboard selection and the background is inert');
  await page.press('Escape', 27);
  await page.until(`!document.querySelector('.modal')`, 'the model picker closed');
  assert(await page.eval(`return !document.querySelector('#app').inert && document.activeElement?.title === 'Model for the new conversation'`), 'Escape restores the model button and the background');
  assert(await page.eval(`
    const st = await import('/js/store.js');
    const { api } = await import('/js/api.js');
    const original = api.get;
    let old, fresh;
    api.get = (url) => url !== '/api/sessions' ? original(url) : new Promise((resolve) => { if (old) fresh = resolve; else old = resolve; });
    try {
      const a = st.loadSessions(), b = st.loadSessions();
      const item = { id: 'profile', path: 'profile', cwdKey: '', cwd: '', title: 'New name' };
      fresh({ sessions: [item] });
      await b;
      old({ sessions: [{ ...item, title: 'Old name' }] });
      await a;
      return st.S.sessions[0]?.title === 'New name';
    } finally {
      api.get = original;
      await st.loadSessions();
    }
  `), 'a delayed session-list response cannot restore an older title');
  const stillPaints = await page.eval(`
    const st = await import('/js/store.js');
    const proto = CanvasRenderingContext2D.prototype;
    const clearRect = proto.clearRect;
    let paints = 0;
    proto.clearRect = function (...args) {
      if (this.canvas.classList.contains('ascii-orbit')) paints++;
      return Reflect.apply(clearRect, this, args);
    };
    try {
      st.savePrefs({ screenReader: true });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const before = paints;
      await new Promise((r) => setTimeout(r, 1150));
      return paints - before;
    } finally {
      proto.clearRect = clearRect;
      await st.savePrefs({ screenReader: false });
    }
  `);
  assert(stillPaints === 0, `the reduced-motion orbit holds its frame without periodic repaints (${stillPaints})`);
  const status = '#welcome .home-status';
  const dirtyFile = path.join(repo, 'typing ñ.txt');
  await page.until(`document.querySelector('${status}')?.textContent.includes('Working tree clean')`, 'a clean working tree');
  assert((await page.text(status)).includes('main'), 'the current Git branch');
  assert(await page.eval(`return !!document.querySelector('#welcome .branch-pick')`), 'the Git worktree option');
  await page.fill('#welcome textarea', 'A draft in progress');
  fs.writeFileSync(dirtyFile, 'Not yet committed.\n');
  await page.click('Refresh working tree', status);
  await page.until(`document.querySelector('${status}')?.textContent.includes('1 changed file')`, 'working tree refresh');
  assert(await page.eval(`return document.querySelector('#welcome textarea').value === 'A draft in progress'`), 'refresh preserves the draft');
  assert(model.seen.length === 0, 'checking the working tree does not send a prompt');
  fs.unlinkSync(dirtyFile);
  await page.click('Refresh working tree', status);
  await page.until(`document.querySelector('${status}')?.textContent.includes('Working tree clean')`, 'the working tree is clean again');
  say('home e2e: branch, dirty and clean refresh, draft preserved');
  await shot('14-home-working-tree');
  await page.fill('#welcome textarea', 'Explain sign-in and fix it for mixed-case emails.');
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  const reload = async () => {
    const url = await page.eval(`window.__oldPage = true; return location.href`);
    await page.goto(url);
    await page.until(`!window.__oldPage && document.querySelector('#session .session-inner')`, 'the conversation after reload');
  };
  await page.until(`document.querySelector('.approval .btn.primary')`, 'the first approval before reload');
  await reload();
  await page.until(`document.querySelector('.approval .btn.primary') && document.querySelector('details.work.live')`, 'the restored working turn and approval');
  assert(await page.eval(`return document.querySelectorAll('details.work.live').length === 1`), 'a running turn does not duplicate on reload');
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
    return { open: f.open, facts, tools: f.querySelectorAll('.tool[data-id]').length, replyText: reply?.innerText || '', replyCls: reply?.className || '', afterYou: f.previousElementSibling?.classList.contains('user'), order: [...f.parentNode.children].map((x) => x.tagName.toLowerCase() + '.' + [...x.classList].join('.')).join(' | '), sum: document.querySelector('.turn-sum')?.innerText || '' };`);
  assert(!info.open, 'the steps folded when the turn finished');
  assert(/Read 2 files/.test(info.facts) && /1 search/.test(info.facts) && /Ran 1 command/.test(info.facts) && /Changed 1 file/.test(info.facts), `the facts in the fold (${info.facts})`);
  assert(info.tools === 6, `the five steps and the passed check inside the fold (${info.tools})`);
  assert(!/Read 2 files/.test(info.sum), 'the steps are summed up once (in the fold), not again on the changed-files card');
  assert(info.afterYou, 'the fold follows your message directly (no name plate)');
  assert(info.replyCls.includes('msg') && info.replyText.includes('keyed by lower-case email'), `the final reply right below the fold (${info.order})`);
  assert(info.sum.includes('1 file changed') && info.sum.includes('Review'), 'the changed-files card');
  await page.eval(`document.querySelector('details.work > summary').click()`);
  await page.until(`document.querySelector('details.work').open && [...document.querySelectorAll('details.work .tool[data-id]')].every((x) => x.offsetParent)`, 'the steps shown');
  await shot('13-conversation-steps');
  // The window chrome: the menu row, where you are in the toolbar, the side-panel button, and back / forward.
  const chrome = await page.eval(`return { menus: [...document.querySelectorAll('#menubar .mb-it')].map((b) => b.getAttribute('aria-label') || b.textContent), crumb: document.querySelector('#topbar .crumb.cur')?.textContent || '' };`);
  assert(chrome.menus.join(',') === 'ORBIX,Workspace,View,Window', `the menu row (${chrome.menus})`);
  assert(/explain sign-in/i.test(chrome.crumb), `the conversation in the toolbar (${chrome.crumb})`);
  const was = await page.eval(`return document.querySelector('#app').classList.contains('no-panel')`);
  await page.eval(`document.querySelector('#topbar .tb-panel').click()`);
  await page.until(`document.querySelector('#app').classList.contains('no-panel') === ${!was}`, 'the toolbar button toggles the side panel');
  if (!was) await page.eval(`document.querySelector('#topbar .tb-panel').click()`);
  await page.until(`!document.querySelector('#app').classList.contains('no-panel') && document.querySelectorAll('.ptabs .ptab').length >= 4`, 'the side panel open with its tabs');
  await page.key('2', { ctrl: true, keyCode: 50, code: 'Digit2' });
  await page.until(`!document.querySelector('#runs').hidden`, 'Runs');
  await page.eval(`document.querySelector('#topbar .tb-nav').click()`);
  await page.until(`!document.querySelector('#session').hidden && /explain sign-in/i.test(document.querySelector('#topbar .crumb.cur')?.textContent || '')`, 'Back returns to the conversation');
  say('conversation e2e: menu row, toolbar, side panel and back');
  // Rename through the dialog, as a person does it: the conversation's ··· menu, Rename…, type, Enter. The name is kept exactly
  // as typed, in the toolbar and at once in the sidebar, and the Enter does nothing else (it used to also press the
  // button the focus went back to, which reopened the menu or opened the conversation a second time).
  const exact = 'Hey: fix *login*. Now';
  const renameField = `document.activeElement?.matches('.modal input[type=text]')`;
  await page.mouse('#topbar .tb-more');
  await page.until(`document.querySelector('.menu:not(.leaving)')`, 'the conversation menu');
  await page.click('Rename', '.menu');
  await page.until(renameField, 'the rename dialog');
  await page.eval(`document.activeElement.select()`);
  await page.type(exact);
  await page.press('Enter', 13);
  await page.until(`!document.querySelector('.modal') && !document.querySelector('.menu:not(.leaving)')`, 'the dialog closed, and no menu opened again');
  await page.until(`(async () => { const st = await import('/js/store.js'); return st.activeTab().name === ${JSON.stringify(exact)} && st.S.sessions.some((s) => s.title === ${JSON.stringify(exact)}); })()`, 'the exact name, also in the saved list');
  await page.until(`document.querySelector('#topbar .crumb.cur')?.textContent.includes(${JSON.stringify(exact)})`, 'the new name in the toolbar');
  await page.until(`[...document.querySelectorAll('#sidebar .s-btn')].some((b) => b.textContent.includes(${JSON.stringify(exact)}))`, 'the new name in the sidebar');
  // A double-click on the name opens the dialog with no menu left behind it; a blank name is refused there.
  await page.mouse('#topbar .crumb.cur', 2);
  await page.until(renameField, 'rename on double-click');
  assert(!(await page.eval(`return !!document.querySelector('.menu:not(.leaving)')`)), 'no menu behind the rename dialog');
  await page.eval(`document.activeElement.select()`);
  await page.type(' ');
  await page.press('Enter', 13);
  assert(await page.eval(`return !!document.querySelector('.modal') && !document.querySelector('.modal .field-err').hidden`), 'a blank name is refused and the dialog stays');
  await page.press('Escape', 27);
  await page.until(`!document.querySelector('.modal')`, 'Esc cancels');
  assert(await page.eval(`return document.querySelector('#topbar .crumb.cur').textContent.includes(${JSON.stringify(exact)})`), 'cancelling keeps the name');
  await reload();
  await page.until(`document.querySelector('#topbar .crumb.cur')?.textContent.includes(${JSON.stringify(exact)}) && document.querySelector('details.work:not(.live) .tool')`, 'the saved name and folded tool history after reload');
  assert(await page.eval(`return document.querySelectorAll('.tin > details.work').length === 1 && !document.querySelector('.tin > .msg .tool') && !document.querySelector('.tl-track')`), 'only the work fold contains the old tools, and there is no left rail');
  say('conversation e2e: rename');
  // 👍 on a reply stays marked; 👎 offers what to do next.
  await page.eval(`[...document.querySelectorAll('#session .msg.asst [aria-label="Good reply"]')].pop().click()`);
  assert(await page.eval(`return [...document.querySelectorAll('#session .msg.asst [aria-label="Good reply"]')].pop().getAttribute('aria-pressed') === 'true'`), '👍 marks the reply');
  await page.eval(`[...document.querySelectorAll('#session .msg.asst [aria-label="Bad reply"]')].pop().click()`);
  await page.until(`document.querySelector('.menu') && /Report a problem/.test(document.querySelector('.menu').textContent)`, 'the 👎 menu');
  await page.key('Escape', { keyCode: 27, code: 'Escape' });
  await page.eval(`[...document.querySelectorAll('#session .msg.asst [aria-label="Bad reply"]')].pop().click()`); // un-mark
  assert(await page.eval(`return [...document.querySelectorAll('#session .msg.asst [aria-label="Bad reply"]')].pop().getAttribute('aria-pressed') === 'false'`), '👎 toggles off');
  // Sidebar: archive a conversation (A on its row), then bring it back from the filter menu.
  await page.eval(`(await import('/js/store.js')).loadSessions()`);
  await page.until(`document.querySelector('#sidebar .s-btn[data-path]')`, 'the conversation in the sidebar');
  await page.eval(`const b = document.querySelector('#sidebar .s-btn[data-path]'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));`);
  await page.until(`!document.querySelector('#sidebar .s-btn[data-path]')`, 'the archived conversation left the sidebar');
  await page.eval(`(await import('/js/store.js')).savePrefs({ showArchived: true })`);
  await page.until(`document.querySelector('#sidebar .s-row.archived')`, 'archived conversations shown on request');
  await page.eval(`(await import('/js/store.js')).savePrefs({ showArchived: false, archived: [] })`);
  await page.until(`document.querySelector('#sidebar .s-btn[data-path]') && !document.querySelector('#sidebar .s-row.archived')`, 'unarchived');
  // Settings is a page: Preferences → send with Ctrl+Enter makes Enter a new line; Back returns to the app.
  await page.key(',', { ctrl: true, keyCode: 188, code: 'Comma' });
  await page.until(`document.querySelector('.modal.settings-card .set-tab.cur')`, 'Settings, full window');
  await page.eval(`document.querySelector('#set-general').click()`);
  await page.click('Ctrl+Enter', '.modal.settings-card');
  await page.click('Back to app', '.modal.settings-card .set-nav');
  await page.until(`!document.querySelector('.modal.settings-card')`, 'back to the app');
  const sent = model.seen.length;
  await page.fill('#session textarea', 'one line');
  await page.eval(`document.querySelector('#session textarea').focus()`);
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  await sleep(400);
  assert(model.seen.length === sent && (await page.eval(`return document.querySelector('#session textarea').value`)).includes('one line'), 'with Ctrl+Enter to send, Enter does not send');
  await page.eval(`(await import('/js/store.js')).savePrefs({ sendKey: 'enter' }); document.querySelector('#session textarea').value = ''; document.querySelector('#session textarea').dispatchEvent(new Event('input', { bubbles: true }));`);
  say('conversation e2e: archive, Settings page and send key');
  // Side question: /btw is answered in the side panel, from the conversation, with no tools and nothing added to it.
  const msgsBefore = await page.eval(`return document.querySelectorAll('#session .msg').length`);
  const seenBefore = model.seen.length;
  await page.fill('#session textarea', '/btw which file did you change?');
  await page.eval(`document.querySelector('#session textarea').focus()`);
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  await page.until(`document.querySelector('#panel .ask-q') && !document.querySelector('#panel .ask-qa .pending')`, 'the side question answered', 20000);
  assert(await page.eval(`return !!document.querySelector('#panel .ask-a, #panel .ask-err')`), 'an answer (or its error) in the panel');
  assert(model.seen.length === seenBefore + 1 && model.seen.at(-1).tools.length === 0, 'one model call, without tools');
  assert((await page.eval(`return document.querySelectorAll('#session .msg').length`)) === msgsBefore, 'nothing added to the conversation');
  // Loops: add one, run it now (a new conversation joins the sidebar), then delete it.
  await page.click('Loops', '#sidebar .side-nav');
  await page.until(`document.querySelector('#runs .au-new')`, 'the Loops page');
  await page.click('New loop', '#runs');
  await page.fill('#runs .au-form textarea', 'Say hello from the loop.');
  await page.click('Add loop', '#runs');
  await page.until(`document.querySelector('#runs .au-item')`, 'the loop listed');
  const tabsBefore = await page.eval(`return (await import('/js/store.js')).S.tabs.size`);
  await page.click('Run now', '#runs .au-item');
  await page.until(`(async () => (await import('/js/store.js')).S.tabs.size > ${tabsBefore})()`, 'the loop opened a conversation', 20000);
  await page.click('Delete', '#runs .au-item');
  await page.click('Delete', '.modal');
  await page.until(`!document.querySelector('#runs .au-item')`, 'the loop deleted');
  say('conversation e2e: side question and loops');
  // Shortcuts: record F7 for the sidebar in Settings → Shortcuts, use it, then put the defaults back.
  await page.key(',', { ctrl: true, keyCode: 188, code: 'Comma' });
  await page.until(`document.querySelector('.modal.settings-card')`, 'Settings');
  await page.eval(`document.querySelector('#set-keys').click()`);
  await page.eval(`document.querySelector('[aria-label="Add keys for Show or hide the sidebar"]').click()`);
  await page.until(`document.querySelector('.kc-rec')`, 'recording keys');
  await page.key('F7', { keyCode: 118, code: 'F7' });
  await page.until(`(async () => ((await import('/js/store.js')).S.ui.keys?.sidebar || []).includes('F7'))()`, 'F7 saved for the sidebar');
  assert(await page.eval(`return !!document.querySelector('.modal.settings-card')`), 'recording a key does not close Settings');
  await page.key('Escape', { keyCode: 27, code: 'Escape' });
  await page.until(`!document.querySelector('.modal.settings-card')`, 'Settings closed');
  const side0 = await page.eval(`return !document.querySelector('#app').classList.contains('no-side')`);
  await page.key('F7', { keyCode: 118, code: 'F7' });
  await page.until(`(document.querySelector('#app').classList.contains('no-side')) === ${side0}`, 'F7 toggled the sidebar');
  await page.key('F7', { keyCode: 118, code: 'F7' });
  await page.eval(`(await import('/js/store.js')).savePrefs({ keys: {} })`);
  // Ctrl+K finds a setting by name and opens its page.
  await page.key('k', { ctrl: true, keyCode: 75, code: 'KeyK' });
  await page.until(`document.querySelector('.palette input')`, 'search');
  await page.fill('.palette input', 'network access');
  await page.click('Network access rules', '.palette');
  await page.until(`document.querySelector('.modal.settings-card .set-title')?.textContent === 'Network access rules'`, 'the network rules page');
  await page.key('Escape', { keyCode: 27, code: 'Escape' });
  await page.until(`!document.querySelector('.modal.settings-card')`, 'Settings closed');
  say('conversation e2e: shortcuts and settings search');
  await page.click('New conversation', '#sidebar');
  await page.fill('#welcome textarea', 'Show activity after a partial reply.');
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  await page.until(`document.querySelector('.approval .btn.primary')`, 'an approval after initial text');
  assert(await page.eval(`return document.querySelectorAll('.tin > details.work.live').length === 1 && !!document.querySelector('.tin > details.work.live .tool') && !document.querySelector('.tin > .msg .tool')`), 'late tools stay inside the live activity row');
  await page.click('Allow once', '.approval');
  await page.until(`document.querySelector('.tin > details.work:not(.live) + .msg .md')?.textContent.includes('Final answer after the check.')`, 'the final answer below the finished activity');
  assert(await page.eval(`return !document.querySelector('.tin > .msg .tool') && !document.querySelector('.tl-track, .session-inner > .tl') && getComputedStyle(document.querySelector('.mb-brand .wm-dot')).animationName === 'none'`), 'no loose calls, no dotted rail, no idle logo animation');
  await page.fill('#session textarea', 'Keep this as the second message.');
  await page.key('Enter', { keyCode: 13, code: 'Enter' });
  await page.until(`document.querySelectorAll('.turn-map .turn-mark.you').length === 2 && document.querySelectorAll('.turn-map .turn-mark.agent').length >= 1 && document.querySelector('.turn-mark[aria-current]') && document.querySelector('.turn-mark.seen')`, 'the timeline has a dot per message and lights the ones on screen');
  assert(await page.eval(`const d = [...document.querySelectorAll('.turn-mark')]; return d.every((b) => /^(Your message|Reply) \\d+ of \\d+/.test(b.getAttribute('aria-label'))) && d.filter((b) => b.tabIndex === 0).length === 1`), 'every dot is labelled, and the strip is one tab stop');
  await page.mouse('.turn-mark.you');
  await page.until(`document.querySelector('.tin .msg.user')?.classList.contains('tl-flash') && document.querySelector('.tm-tip.on')`, 'a dot shows its first line and jumps to its message');
  assert(await page.eval(`return document.querySelector('.turn-map').getBoundingClientRect().height <= 250`), 'the timeline is a short stack, not a full-height rail');
  say('conversation e2e: tools after an initial answer');
  if (DESKTOP) {
    // The built-in browser shows a web page in the Windows app (a <webview> with its own session).
    const http = await import('node:http');
    const site = http.createServer((_q, r) => (r.writeHead(200, { 'content-type': 'text/html' }), r.end('<!doctype html><title>E2E page</title><h1>Hello from the browser tab</h1>')));
    await new Promise((ok) => site.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${site.address().port}/`;
    await page.eval(`const st = await import('/js/store.js'); st.setActive([...st.S.tabs.keys()][0]);`);
    await page.until(`(async () => !!(await import('/js/store.js')).activeTab())()`, 'a conversation in front');
    await page.eval(`(await import('/js/store.js')).emit('browse', ${JSON.stringify(url)})`);
    await page.until(`document.querySelector('#panel webview')`, 'the browser view');
    await page.until(`(() => { try { return document.querySelector('#panel webview').getTitle() === 'E2E page'; } catch { return false; } })()`, 'the page loaded in the browser view', 20000);
    await sleep(600);
    await shot('browser-tab');
    site.close();
    say('conversation e2e: built-in browser');
    // Settings → About in the Windows app: the tray and keeping the PC awake switch on and off cleanly.
    assert(await page.eval(`return !!window.orbixDesktop.system`), 'the system bridge');
    await page.eval(`const st = await import('/js/store.js'); await st.savePrefs({ tray: true, preventSleep: true }); await new Promise((r) => setTimeout(r, 3500)); await st.savePrefs({ tray: false, preventSleep: false }); await new Promise((r) => setTimeout(r, 500));`);
    say('conversation e2e: tray and prevent sleep');
  }
  const bad = page.errors.filter((e) => e && !/favicon|Failed to load resource/i.test(e));
  assert(!bad.length, `no page errors: ${bad.join(' | ')}`);
  ok = true;
  say('conversation e2e: passed');
} catch (e) {
  say(`conversation e2e: FAILED — ${e.message}\nKept: ${root}`);
} finally {
  page?.close();
  orbix?.proc.kill();
  model.server.close();
}
if (ok && !KEEP) {
  // Windows holds files of the closed browser and server for a moment: wait, then remove the folder before exiting.
  await sleep(800);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  } catch (e) {
    say(`Note: could not remove ${root} (${e.code}); delete it later.`);
  }
}
process.exit(ok ? 0 : 1);
