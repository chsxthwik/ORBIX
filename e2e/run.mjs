#!/usr/bin/env node
// Desktop end-to-end tests of a run, through the real interface, against the deterministic model fixture.
//
//   node e2e/run.mjs            run everything (about a minute); exit code 0 only when every step passed
//   node e2e/run.mjs --keep     keep the temporary folder (server log, data folder, fixture repository)
//   node e2e/run.mjs --shots    also write screenshots to docs/evidence/
//
// What it proves, clicking the same buttons you would:
//   open a Git repository, describe a task, see the plan, comment on it and get a revision, approve it with a scope,
//   changes are made in a separate worktree, the tests run, the diff, test log and walkthrough can be read, the
//   changes are applied while the project has uncommitted work of yours; a destructive command is denied from the
//   Review queue; ORBIX is killed mid-run and restarted, the run and its evidence are recovered, and the interrupted
//   action is only continued after you say so; a conflicting change is refused without touching either side.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sleep, startModel, makeRepo, writeConfig, startOrbix, startBrowser, tmpRoot, git } from './lib.mjs';

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const SHOTS = args.includes('--shots');
const EVID = path.join(ROOT, 'docs', 'evidence');
const results = [];
const say = (s) => process.stdout.write(s + '\n');
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const assert = (cond, what) => {
  if (!cond) throw new Error(`Expected: ${what}`);
};

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    say(`  ✔ ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    say(`  ✖ ${name}\n      ${e.message}`);
    throw e;
  }
}

async function main() {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  const repo = makeRepo(path.join(root, 'shop api ñ')); // a space and a non-ASCII letter in the path
  const model = await startModel();
  writeConfig(data, model.port, [repo]);
  let orbix = await startOrbix(data);
  const page = await startBrowser(path.join(root, 'browser'), { scale: 2 }); // 2 = a high-DPI screen
  const shot = (name) => (SHOTS ? page.shot(path.join(EVID, `${name}.png`)) : null);
  const api = (p) => page.eval(`const r = await fetch(${JSON.stringify(p)}, { headers: { 'x-orbix': '1' } }); return r.json();`);
  const runs = async () => (await api('/api/runs')).runs;
  const statusOf = async (id) => (await runs()).find((r) => r.id === id)?.status;
  const waitStatus = async (id, st, ms = 40000) => {
    const t0 = Date.now();
    for (;;) {
      const now = await statusOf(id);
      if (now === st) return;
      if (Date.now() - t0 > ms) throw new Error(`The run is "${now}", expected "${st}"`);
      await sleep(150);
    }
  };
  const startRun = async (task, mode) => {
    await page.key('2', { ctrl: true, keyCode: 50, code: 'Digit2' });
    await page.until(`document.querySelector('#runs .run-new textarea')`, 'the Runs view');
    await page.fill('#runs .run-new textarea', task);
    await page.click(mode === 'direct' ? 'Straight to work' : 'Plan first', '#runs .run-new');
    const before = new Set((await runs()).map((r) => r.id));
    await page.click('Start run', '#runs .run-new');
    await page.until(`document.querySelector('#runs .run-page .run-head h1')`, 'the run page');
    const made = (await runs()).find((r) => !before.has(r.id));
    assert(made, 'a new run');
    return made.id;
  };
  let ok = false;
  try {
    say(`ORBIX e2e · ${page.exe}\n  data: ${data}\n  repo: ${repo}`);
    await page.goto(orbix.url);

    let id;
    await step('Runs opens with Ctrl+2 and shows the project', async () => {
      await page.key('2', { ctrl: true, keyCode: 50, code: 'Digit2' });
      await page.until(`document.querySelector('#runs .run-new textarea') && !document.querySelector('#runs').hidden`, 'the Runs view');
      assert((await page.text('#runs .run-proj select')).includes('shop api ñ'), 'the fixture project in the project list');
      await shot('01-runs-empty');
    });

    await step('Describe a task: the agent plans without changing anything', async () => {
      id = await startRun('Sign-in fails for emails with capital letters. Fix it and add a test.', 'plan');
      await waitStatus(id, 'awaiting_plan');
      await page.until(`document.querySelector('#runs .art-doc')?.innerText.includes('lower-case the email before the lookup')`, 'the plan on screen');
      assert((await page.text('#runs .run-decision')).includes('Approve plan'), 'the Approve plan button');
      const r = (await runs()).find((x) => x.id === id);
      assert(read(repo, 'src/auth.js').includes('return findByEmail(email);'), 'the project untouched');
      assert(read(r.workspace, 'src/auth.js').includes('return findByEmail(email);'), 'the worktree untouched while planning');
      assert(r.worktree.path.includes('.orbix') && r.worktree.branch.startsWith('orbix/'), 'a separate worktree and branch');
      const planReq = model.seen.find((s) => s.scenario === 'bug fix with a plan' && s.step === 0);
      assert(planReq.tools.includes('artifact') && !planReq.tools.includes('write') && !planReq.tools.includes('bash'), 'only read-only tools while planning');
      await shot('02-plan-ready');
    });

    await step('The timeline links a step to what it produced', async () => {
      await page.until(`['You started the run', 'Saved the plan, revision 1', 'The plan is ready for your review'].every((t) => document.querySelector('#runs .rsteps')?.innerText.includes(t))`, 'the timeline rows');
      await page.click('Changes', '#runs .run-tabs');
      await page.until(`document.querySelector('#runs .run-body')?.innerText.includes('Nothing has been changed yet')`, 'the empty Changes tab');
      await page.eval(`[...document.querySelectorAll('#runs .rstep-btn')].find((b) => b.tagName === 'BUTTON' && b.innerText.includes('Saved the plan')).click()`);
      await page.until(`document.querySelector('#runs .run-tab.cur')?.innerText.startsWith('Plan') && document.querySelector('#runs .art-doc')`, 'the plan opened from the timeline');
    });

    await step('Comment on the plan, send feedback, get revision 2', async () => {
      await page.click('Comment', '#runs .art-bar');
      await page.fill('.modal textarea', 'Also handle spaces around the address.');
      await page.click('Add comment', '.modal');
      await page.until(`document.querySelector('#runs .cmt')?.innerText.includes('not sent yet')`, 'the pending comment');
      await page.until(`document.querySelector('#runs .run-feedback button')?.innerText.includes('Send with 1 comment')`, 'the comment counted on the send button');
      await page.fill('#runs .run-feedback textarea', 'Keep the change small.');
      await page.click('Send with 1 comment', '#runs .run-feedback');
      await page.until(`document.querySelector('#runs .art-doc')?.innerText.includes('trim and lower-case')`, 'revision 2 on screen', 40000);
      await waitStatus(id, 'awaiting_plan');
      const sent = model.seen.find((s) => s.scenario === 'bug fix with a plan' && s.step === 3);
      assert(sent.last.includes('Keep the change small.') && sent.last.includes('Also handle spaces around the address.'), 'the feedback and the comment reached the model');
      assert((await page.text('#runs .run-tabs')).includes('r2'), 'the revision count on the tab');
      // Revision 1 is still readable.
      await page.eval(`const s = document.querySelector('#runs .art-rev'); s.value = '1'; s.dispatchEvent(new Event('change'));`);
      await page.until(`document.querySelector('#runs .art-old') && !document.querySelector('#runs .art-doc').innerText.includes('trim and')`, 'revision 1');
      await page.click('Show revision 2', '#runs .art-old');
      await page.until(`!document.querySelector('#runs .art-old')`, 'back on the latest revision');
    });

    await step('Approve with a scope: the dialog says exactly what is allowed', async () => {
      await page.click('Approve plan', '#runs .run-decision');
      await page.until(`document.querySelector('.modal .scope')`, 'the approval dialog');
      const dlg = await page.text('.modal');
      const r = (await runs()).find((x) => x.id === id);
      assert(dlg.includes(r.worktree.path) && dlg.includes(r.worktree.branch) && dlg.includes('Always asks') && dlg.includes('revision 2'), 'the worktree, the branch, the revision and the limits in the dialog');
      await shot('03-approve-scope');
      await page.click('Edit files and run commands in the worktree', '.modal');
      await page.click('Approve and start', '.modal');
      await waitStatus(id, 'review', 90000);
    });

    await step('Changes were made in the worktree only, and the tests ran', async () => {
      const r = (await runs()).find((x) => x.id === id);
      assert(read(r.workspace, 'src/auth.js').includes('.trim().toLowerCase()'), 'the fix in the worktree');
      assert(read(repo, 'src/auth.js').includes('return findByEmail(email);'), 'the project still untouched');
      assert(r.checks?.status === 'passed' && r.checks.command === 'npm test', `the checks passed (${JSON.stringify(r.checks)})`);
      assert(r.scope.edits && r.scope.commands && r.scope.planRev === 2, 'the approved scope recorded');
      const ev = (await api(`/api/run?id=${id}`)).events;
      assert(!ev.some((e) => e.type === 'approval.requested'), 'no approval was needed inside the approved scope');
      assert(ev.some((e) => e.type === 'tool.result' && e.name === 'bash' && e.ok && e.exitCode === 0), 'the test command result in the log');
    });

    await step('Review: walkthrough, diff, test log', async () => {
      await page.until(`document.querySelector('#runs .run-tab.cur')?.innerText.startsWith('Walkthrough') && document.querySelector('#runs .art-doc')?.innerText.includes('What changed')`, 'the walkthrough');
      await shot('04-walkthrough');
      await page.click('Changes', '#runs .run-tabs');
      await page.until(`document.querySelectorAll('#runs .chg-file').length === 2 && document.querySelector('#runs .chg-diff')?.innerText.includes('toLowerCase')`, 'the diff of two files');
      await shot('05-changes');
      await page.click('Test log', '#runs .run-tabs');
      await page.until(`document.querySelector('#runs .art-doc')?.innerText.includes('Passed') && document.querySelector('#runs .art-doc').innerText.includes('npm test')`, 'the test log');
      assert(/pass 3/.test(await page.text('#runs .art-doc')), 'the test output (3 passing) in the log');
    });

    await step('The Review queue lists it; apply keeps your uncommitted work', async () => {
      fs.writeFileSync(path.join(repo, 'README.md'), '# shop-api\n\nAccounts and sign-in for the shop.\n\nMy own note, not committed.\n');
      await page.key('3', { ctrl: true, keyCode: 51, code: 'Digit3' });
      await page.until(`document.querySelector('#runs .rq-item')?.textContent.includes('Changes are ready for your review')`, 'the run in the Review queue');
      assert((await page.text('#sidebar .side-count')).trim() === '1', 'the count on Review in the sidebar');
      await shot('06-review-queue');
      await page.click('Apply changes', '#runs .rq-item');
      await page.until(`document.querySelector('.modal')?.innerText.includes('2 changed files')`, 'the apply confirmation');
      await page.click('Apply changes', '.modal');
      await waitStatus(id, 'applied');
      assert(read(repo, 'src/auth.js').includes('.trim().toLowerCase()'), 'the fix in the project');
      assert(read(repo, 'README.md').includes('My own note, not committed.'), 'your uncommitted edit kept');
      assert(/Merge orbix\//.test(git(repo, 'log', '--oneline', '-1')), 'a merge commit');
      await page.until(`document.querySelector('#runs .empty')?.innerText.includes('Nothing is waiting for you')`, 'an empty queue');
      git(repo, 'checkout', '--', 'README.md');
    });

    await step('A destructive command asks, and Deny from the Review queue stops it', async () => {
      const rid = await startRun('Publish the docs branch.', 'direct');
      await page.key('3', { ctrl: true, keyCode: 51, code: 'Digit3' });
      await page.until(`document.querySelector('#runs .ask-card')?.innerText.includes('It pushes to a remote')`, 'the approval in the queue');
      assert(!(await page.text('#runs .ask-card')).includes('Allow for this session'), 'no lasting permission offered for a destructive command');
      await shot('07-approval-denied');
      await page.click('Deny', '#runs .ask-card');
      await waitStatus(rid, 'review');
      const ev = (await api(`/api/run?id=${rid}`)).events;
      const asked = ev.find((e) => e.type === 'approval.requested');
      assert(ev.find((e) => e.type === 'approval.resolved' && e.ask === asked.ask)?.answer === 'Deny', 'the denial in the log');
      assert(ev.find((e) => e.type === 'tool.result' && e.name === 'bash')?.ok === false, 'the command did not run');
      await page.eval(`[...document.querySelectorAll('#runs .rq-head')][0].click()`);
      await page.until(`document.querySelector('#runs .run-page')`, 'the run page');
      await page.click('Discard', '#runs .run-decision');
      await page.click('Discard', '.modal');
      await waitStatus(rid, 'discarded');
      const gone = (await runs()).find((x) => x.id === rid);
      assert(!fs.existsSync(gone.worktree.path), 'the worktree removed');
    });

    let rid;
    await step('Restart mid-run: ORBIX is killed while a command runs', async () => {
      rid = await startRun('Add a changelog file.', 'plan');
      await waitStatus(rid, 'awaiting_plan');
      await page.click('Approve plan', '#runs .run-decision');
      await page.click('Edit files and run commands in the worktree', '.modal');
      await page.click('Approve and start', '.modal');
      const t0 = Date.now();
      for (;;) {
        const ev = (await api(`/api/run?id=${rid}`)).events;
        if (ev.some((e) => e.type === 'tool.call' && e.name === 'bash')) break;
        if (Date.now() - t0 > 30000) throw new Error('The long command never started');
        await sleep(150);
      }
      orbix.proc.kill('SIGKILL'); // no clean shutdown
      await sleep(600);
      orbix = await startOrbix(data);
      await page.goto(orbix.url);
    });

    await step('After the restart the run, its plan and its log are there, marked interrupted', async () => {
      assert((await statusOf(rid)) === 'interrupted', `the run is interrupted (it is ${await statusOf(rid)})`);
      await page.key('3', { ctrl: true, keyCode: 51, code: 'Digit3' });
      await page.until(`document.querySelector('#runs .rq-item')?.textContent.includes('Interrupted when ORBIX closed')`, 'the interrupted run in the queue');
      assert((await page.text('#runs .rq-item')).includes('setTimeout'), 'the action in flight named in the queue');
      await page.eval(`[...document.querySelectorAll('#runs .rq-head')][0].click()`);
      await page.until(`document.querySelector('#runs .run-page .rsteps')`, 'the run page');
      await page.click('Plan', '#runs .run-tabs');
      await page.until(`document.querySelector('#runs .art-doc')?.innerText.includes('Add a changelog')`, 'the plan after the restart');
      await page.until(`['You approved the plan', 'Interrupted: ORBIX closed', 'outcome unknown'].every((t) => document.querySelector('#runs .rsteps')?.innerText.includes(t))`, 'the approval and the interruption in the timeline');
      const r = (await runs()).find((x) => x.id === rid);
      assert(read(r.workspace, 'CHANGELOG.md').includes('0.3.0'), 'the work in the worktree survived');
      await shot('08-interrupted');
    });

    await step('Resume needs your OK for the action whose outcome is unknown', async () => {
      await page.click('Resume', '#runs .run-decision');
      await page.until(`document.querySelector('.modal .pending-calls')`, 'the dialog listing what was in flight');
      assert((await page.text('.modal')).includes('setTimeout') && (await page.text('.modal')).includes('will not run it again by itself'), 'the command and the promise not to repeat it');
      await shot('09-resume-dialog');
      await page.click('Continue, check first', '.modal');
      await waitStatus(rid, 'review', 60000);
      const told = model.seen.filter((s) => s.scenario === 'interrupted by a restart').find((s) => s.last.includes('ORBIX was closed while you were working'));
      assert(told && told.last.includes('Do not repeat them blindly'), 'the agent was told to check first');
      const ev = (await api(`/api/run?id=${rid}`)).events;
      assert(ev.some((e) => e.type === 'recover.interrupted') && ev.some((e) => e.type === 'recover.acknowledged'), 'the recovery in the log');
      const bash = ev.filter((e) => e.type === 'tool.call' && e.name === 'bash').map((e) => e.detail);
      assert(bash.filter((c) => c.includes('setTimeout')).length === 1, 'the interrupted command was not run a second time');
      await page.until(`document.querySelector('#runs .run-decision')?.innerText.includes('Apply changes')`, 'the decision bar');
      await page.click('Apply changes', '#runs .run-decision');
      await page.click('Apply changes', '.modal');
      await waitStatus(rid, 'applied');
      assert(read(repo, 'CHANGELOG.md').includes('0.3.0'), 'the changelog in the project');
    });

    await step('A conflict is refused and leaves both sides as they were', async () => {
      const cid = await startRun('Change the readme title.', 'direct');
      // Commands were not part of this run's scope, so the project's check asks first; the question shows on the run page.
      await page.until(`document.querySelector('#runs .run-decision .ask-card')?.innerText.includes('Check the changes with npm test?')`, 'the question about running the check');
      await page.click('Run the check', '#runs .run-decision');
      await waitStatus(cid, 'review');
      fs.writeFileSync(path.join(repo, 'README.md'), '# shop-api (mine)\n\nAccounts and sign-in for the shop.\n');
      git(repo, 'commit', '-qam', 'My title');
      const head = git(repo, 'rev-parse', 'HEAD').trim();
      await page.click('Apply changes', '#runs .run-decision');
      await page.click('Apply changes', '.modal');
      await page.until(`document.querySelector('.modal')?.innerText.includes('conflict with your branch')`, 'the conflict dialog');
      assert((await page.text('.modal')).includes('README.md') && (await page.text('.modal')).includes('Nothing was changed'), 'the file named, and nothing changed');
      await shot('10-conflict');
      await page.click('Close', '.modal');
      assert(git(repo, 'rev-parse', 'HEAD').trim() === head && !fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'the project as it was');
      assert((await statusOf(cid)) === 'review', 'the run still in review');
      const r = (await runs()).find((x) => x.id === cid);
      assert(read(r.workspace, 'README.md').includes('(accounts)'), 'the run’s change still in its worktree');
    });

    await step('Keyboard and accessibility basics', async () => {
      await page.key('2', { ctrl: true, keyCode: 50, code: 'Digit2' });
      await page.until(`document.querySelector('#runs .run-group')`, 'the Runs list');
      const info = await page.eval(`
        const rows = [...document.querySelectorAll('#runs .rrow')];
        rows[0].focus();
        const ring = getComputedStyle(rows[0], null).outlineStyle;
        return { rows: rows.length, focusable: document.activeElement === rows[0], buttons: rows.every((r) => r.tagName === 'BUTTON'), nav: [...document.querySelectorAll('#sidebar .side-nav .side-link')].map((b) => b.getAttribute('aria-current') || ''), dpr: devicePixelRatio, ring };`);
      assert(info.rows >= 4 && info.focusable && info.buttons, 'every run row is a focusable button');
      assert(info.nav.filter((x) => x === 'page').length === 1, 'exactly one current page in the navigation');
      assert(info.dpr === 2, 'rendered at 2x (high DPI)');
      await page.key('1', { ctrl: true, keyCode: 49, code: 'Digit1' });
      await page.until(`document.querySelector('#runs').hidden && !document.querySelector('#welcome').hidden`, 'Home with Ctrl+1');
      await shot('11-home');
    });

    await step('No errors in the page console', async () => {
      const bad = page.errors.filter((e) => e && !/favicon|net::ERR_CONNECTION_REFUSED|Failed to load resource|Lost connection/i.test(e));
      assert(!bad.length, `no page errors, got:\n      ${bad.slice(0, 5).join('\n      ')}`);
    });
    ok = true;
  } finally {
    page.close();
    orbix.proc.kill();
    model.server.close();
    const passed = results.filter((r) => r.ok).length;
    say(`\n${passed}/${results.length} steps passed${ok ? '' : ' — FAILED'}`);
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'e2e-run-workflow.json'), JSON.stringify({ at: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, node: process.version, browser: path.basename(page.exe), ok, results }, null, 2) + '\n');
    if (KEEP || !ok) say(`Kept: ${root}`);
    else {
      await sleep(800);
      // Windows can hold a file of the closed browser for a moment; a leftover temp folder is not a test failure.
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
      } catch (e) {
        say(`Note: could not remove ${root} (${e.code}); delete it later.`);
      }
    }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  say(`\nFAILED: ${e.message}`);
  process.exit(1);
});
