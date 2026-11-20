// Partial acceptance of a run's changes (some files, or some hunks of a file) and comments on lines of a diff.
// Real git, a scratch repository, and the run controller without a model: the "agent" edits the worktree directly.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-partial-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
process.env.GIT_CEILING_DIRECTORIES = TMP;
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'tester';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';

const { RunStore } = await import('../src/runs.mjs');
const { RunController, commentLines, commentWhere } = await import('../src/runctl.mjs');
const { Backend } = await import('../src/backend.mjs');
const gitapi = await import('../src/gitapi.mjs');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const g = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// =====================================================================================================================
describe('patches: split into files and hunks, keep only what was chosen', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index 1111111..2222222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    '-one',
    '+ONE',
    ' two',
    ' three',
    '@@ -20,2 +20,2 @@',
    ' x',
    '-y',
    '+Y',
    '\\ No newline at end of file',
    'diff --git a/new file.txt b/new file.txt',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/new file.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git "a/sp\\303\\261\\"q.txt" "b/sp\\303\\261\\"q.txt"',
    'index 4444444..5555555 100644',
    'Binary files a/sp\u00f1"q.txt and b/sp\u00f1"q.txt differ',
    '',
  ].join('\n');

  test('files, their paths (quoted ones too) and their hunks', () => {
    const files = gitapi.parsePatch(patch);
    assert.deepEqual(files.map((f) => [f.path, f.hunks.length, f.whole]), [['a.txt', 2, false], ['new file.txt', 1, true], ['sp\u00f1"q.txt', 0, true]]);
    assert.equal(files[0].hunks[1].at(-1), '\\ No newline at end of file', 'the no-newline marker stays with its hunk');
  });

  test('only the chosen hunks are kept; a file with none chosen is left out; a new file is whole', () => {
    const files = gitapi.parsePatch(patch);
    const second = gitapi.pickPatch(files, { 'a.txt': [1] });
    assert.ok(second.includes('@@ -20,2 +20,2 @@') && !second.includes('@@ -1,3 +1,3 @@'));
    assert.ok(second.includes('+hello'), 'files without a choice keep everything');
    const none = gitapi.pickPatch(files, { 'a.txt': [], 'new file.txt': [], 'sp\u00f1"q.txt': [] });
    assert.equal(none, '');
    assert.ok(gitapi.pickPatch(files, { 'new file.txt': [0] }).includes('new file mode 100644'));
  });
});

// =====================================================================================================================
describe('comments on diff lines', () => {
  const store = new RunStore(path.join(TMP, 'cstore'));
  const id = store.create({ project: 'C:\\x', task: 'Comment on lines' }).id;

  test('a comment on lines names path:line and quotes them for the agent', () => {
    const one = store.addComment(id, { target: 'src/a.js', line: 12, quote: 'const a = 1;', text: 'Use let' });
    const range = store.addComment(id, { target: 'src/a.js', line: '3', lineEnd: '4', quote: 'if (x) {\n  y();', text: 'Invert this' });
    const removed = store.addComment(id, { target: 'src/b.js', line: 7, side: 'old', quote: 'keep()', text: 'Why was this removed?' });
    const whole = store.addComment(id, { target: 'src/c.js', text: 'Rename this file' });
    const plan = store.addComment(id, { target: 'plan', rev: 2, quote: 'Step 1', text: 'Shorter' });
    assert.deepEqual([one.line, one.lineEnd, one.side], [12, 12, 'new']);
    assert.deepEqual([range.line, range.lineEnd], [3, 4]);
    assert.equal(whole.line, undefined);
    assert.deepEqual([one, range, removed, whole].map(commentWhere), ['src/a.js:12', 'src/a.js:3-4', 'src/b.js:7', 'src/c.js']);
    const text = commentLines([one, range, removed, whole, plan]).join('\n');
    assert.match(text, /- On `src\/a\.js:12`: Use let\n {4}> const a = 1;/);
    assert.match(text, /- On `src\/a\.js:3-4`: Invert this\n {4}> if \(x\) \{\n {4}>   y\(\);/);
    assert.match(text, /- On `src\/b\.js:7` \(removed by your change; numbered as in the original file\): Why was this removed\?/);
    assert.match(text, /- On `src\/c\.js`: Rename this file/);
    assert.match(text, /- On the implementation plan \(revision 2\), about "Step 1": Shorter/);
    const logged = store.events(id).filter((e) => e.type === 'comment.added');
    assert.deepEqual(logged.map((e) => e.line ?? null), [12, 3, 7, null, null], 'the log records the lines');
  });

  test('lines that make no sense are refused', () => {
    assert.throws(() => store.addComment(id, { target: 'a.js', line: 5, lineEnd: 2, text: 'x' }), /cannot be commented/);
    assert.throws(() => store.addComment(id, { target: 'a.js', line: -1, text: 'x' }), /cannot be commented/);
    assert.throws(() => store.addComment(id, { target: 'a.js', line: 1.5, text: 'x' }), /cannot be commented/);
    assert.throws(() => store.addComment(id, { target: 'plan', line: 3, text: 'x' }), /cannot be commented/);
  });
});

// =====================================================================================================================
describe('partial apply (real git)', () => {
  const backend = new Backend({ kind: 'native' });
  let repo;
  let ctl;
  const server = { backend, procs: new Map(), broadcast: () => {}, broadcastProcs: () => {} };

  /** A run whose agent is done: its worktree has the edits `edit` makes, and it waits for review. */
  async function runWith(task, edit) {
    const run = ctl.store.create({ project: repo, task, mode: 'direct' });
    const wt = await gitapi.worktreeAdd(backend, repo);
    ctl.store.update(run.id, { workspace: wt.workspace, worktree: { repo: wt.repo, slug: wt.slug, path: wt.path, branch: wt.branch, base: wt.base, baseBranch: wt.baseBranch } });
    edit(wt.path);
    ctl.store.setStatus(run.id, 'review');
    return ctl.store.get(run.id);
  }
  const types = (id) => ctl.store.events(id).map((e) => e.type);
  const clean = () => g(repo, 'status', '--porcelain', '--untracked-files=no').trim();

  before(() => {
    repo = path.join(TMP, 'shop ñ');
    fs.mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q');
    g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    put(repo, 'a.txt', 'a\n');
    put(repo, 'b.txt', 'b\n');
    put(repo, 'c.txt', 'c\n');
    put(repo, 'long.txt', LONG);
    put(repo, 'notes.txt', 'mine\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'start');
    ctl = new RunController(server, path.join(TMP, 'data', 'runs'));
  });

  test('a subset of files is applied; the rest stays in the worktree and the log says exactly what went where', async () => {
    const run = await runWith('Three edits', (w) => {
      put(w, 'a.txt', 'a (run)\n');
      put(w, 'b.txt', 'b (run)\n');
      put(w, 'new dir/new.txt', 'new\n'); // a new file, not committed by the agent
    });
    const d = await ctl.diff(run.id);
    assert.deepEqual(d.files.map((f) => f.path), ['a.txt', 'b.txt', 'new dir/new.txt']);
    assert.match(d.tree, /^[0-9a-f]{40}$/);
    put(repo, 'notes.txt', 'mine, edited\n'); // your own uncommitted work in another file
    const head = g(repo, 'rev-parse', 'HEAD').trim();
    const r = await ctl.apply(run.id, { files: ['a.txt', 'new dir/new.txt'] });
    assert.deepEqual([r.applied, r.partial, r.remaining], [true, true, ['b.txt']]);
    // The target got exactly the chosen files, as one commit on top of where it was.
    assert.equal(read(repo, 'a.txt'), 'a (run)\n');
    assert.equal(read(repo, 'new dir/new.txt'), 'new\n');
    assert.equal(read(repo, 'b.txt'), 'b\n', 'the file you did not choose is untouched in your checkout');
    assert.equal(read(repo, 'notes.txt'), 'mine, edited\n', 'your uncommitted work is kept');
    assert.equal(g(repo, 'rev-parse', 'HEAD~1').trim(), head);
    assert.deepEqual(g(repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').trim().split('\n'), ['a.txt', 'new dir/new.txt']);
    // The worktree still has everything, and the run is still open with only b.txt left to review.
    const wt = ctl.store.get(run.id).worktree.path;
    assert.equal(read(wt, 'b.txt'), 'b (run)\n');
    assert.equal(read(wt, 'a.txt'), 'a (run)\n');
    assert.equal(ctl.store.get(run.id).status, 'review');
    assert.deepEqual((await ctl.diff(run.id)).files.map((f) => f.path), ['b.txt']);
    // Recorded: in the run's state and in its log.
    const acc = ctl.store.get(run.id).accepted;
    assert.deepEqual(acc.parts.map((p) => [p.files, p.hash]), [[['a.txt', 'new dir/new.txt'], r.hash]]);
    const ev = ctl.store.events(run.id).find((e) => e.type === 'apply.partial');
    assert.deepEqual([ev.files, ev.remaining, ev.hash, ev.branch], [['a.txt', 'new dir/new.txt'], ['b.txt'], r.hash, 'main']);
    assert.equal(g(repo, 'rev-parse', `${gitapi.ACCEPTED_REF}/${ctl.store.get(run.id).worktree.slug}`).trim(), acc.base);
    // Applying the rest finishes the run.
    const r2 = await ctl.apply(run.id);
    assert.deepEqual([r2.applied, r2.partial], [true, false]);
    assert.equal(read(repo, 'b.txt'), 'b (run)\n');
    const done = ctl.store.get(run.id);
    assert.equal(done.status, 'applied');
    assert.deepEqual([done.applied.files, done.applied.parts], [3, 2]);
    assert.ok(types(run.id).includes('apply.done'));
    assert.equal(g(repo, 'for-each-ref', gitapi.ACCEPTED_REF).trim(), '', 'a finished run leaves no record ref behind');
    g(repo, 'checkout', '--', 'notes.txt');
  });

  test('one hunk of a file is applied, the other stays to review; a choice made on an older state is refused', async () => {
    const run = await runWith('Two hunks', (w) => put(w, 'long.txt', LONG.replace('line 2\n', 'line 2 (run)\n').replace('line 25\n', 'line 25 (run)\n')));
    const d = await ctl.diff(run.id);
    const fd = await ctl.fileDiff(run.id, 'long.txt', false, d.tree);
    assert.equal(gitapi.parsePatch(fd.text)[0].hunks.length, 2, 'the diff you read has two hunks');
    await assert.rejects(ctl.apply(run.id, { files: ['long.txt'], hunks: { 'long.txt': [1] }, tree: '0'.repeat(40) }), /changed after you chose/);
    await assert.rejects(ctl.apply(run.id, { files: ['nope.txt'] }), /not among the changes/);
    await assert.rejects(ctl.apply(run.id, { files: [] }), /at least one file/);
    const r = await ctl.apply(run.id, { files: ['long.txt'], hunks: { 'long.txt': [1] }, tree: d.tree });
    assert.equal(r.partial, true);
    const now = read(repo, 'long.txt');
    assert.ok(now.includes('line 25 (run)') && !now.includes('line 2 (run)'), 'only the second hunk was applied');
    const left = await ctl.diff(run.id);
    assert.deepEqual(left.files.map((f) => [f.path, f.add, f.del]), [['long.txt', 1, 1]]);
    assert.match((await ctl.fileDiff(run.id, 'long.txt', false, left.tree)).text, /\+line 2 \(run\)/);
    assert.deepEqual(ctl.store.events(run.id).find((e) => e.type === 'apply.partial').hunks, { 'long.txt': [1] });
    await ctl.discard(run.id);
    assert.equal(g(repo, 'for-each-ref', gitapi.ACCEPTED_REF).trim(), '', 'discard drops the record of what was applied');
    assert.ok(read(repo, 'long.txt').includes('line 25 (run)'), 'what was applied stays applied');
  });

  test('your committed edit elsewhere in the same file is merged three-way', async () => {
    const run = await runWith('Edit the top', (w) => put(w, 'long.txt', read(w, 'long.txt').replace('line 1\n', 'line 1 (run)\n')));
    put(repo, 'long.txt', read(repo, 'long.txt').replace('line 30\n', 'line 30 (mine)\n'));
    g(repo, 'commit', '-qam', 'mine at the bottom');
    const r = await ctl.apply(run.id, { files: ['long.txt'] });
    assert.equal(r.applied, true);
    const now = read(repo, 'long.txt');
    assert.ok(now.includes('line 1 (run)') && now.includes('line 30 (mine)'));
    assert.equal(ctl.store.get(run.id).status, 'applied');
  });

  test('a conflict is refused and leaves your checkout exactly as it was', async () => {
    const run = await runWith('Edit c and a', (w) => {
      put(w, 'c.txt', 'c (run)\n');
      put(w, 'a.txt', 'a (run 2)\n');
    });
    put(repo, 'c.txt', 'c (mine)\n');
    g(repo, 'commit', '-qam', 'my c');
    const head = g(repo, 'rev-parse', 'HEAD').trim();
    const r = await ctl.apply(run.id, { files: ['c.txt'] });
    assert.deepEqual([r.applied, r.conflict, r.files], [false, true, ['c.txt']]);
    assert.equal(g(repo, 'rev-parse', 'HEAD').trim(), head, 'no commit was made');
    assert.equal(clean(), '', 'nothing is half-applied: no edited or staged file');
    assert.equal(read(repo, 'c.txt'), 'c (mine)\n');
    assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false);
    const st = ctl.store.get(run.id);
    assert.equal(st.status, 'review');
    assert.equal(st.accepted, undefined, 'nothing is recorded as applied');
    assert.equal(read(st.worktree.path, 'c.txt'), 'c (run)\n', 'the run keeps its change');
    assert.deepEqual(ctl.store.events(run.id).find((e) => e.type === 'apply.conflict').files, ['c.txt']);
    // Your uncommitted edit to a chosen file is refused too, with nothing changed.
    put(repo, 'a.txt', 'a (mine, not committed)\n');
    await assert.rejects(ctl.apply(run.id, { files: ['a.txt'] }), /uncommitted changes to a\.txt/);
    assert.equal(read(repo, 'a.txt'), 'a (mine, not committed)\n');
    assert.ok(types(run.id).includes('apply.refused'));
    g(repo, 'checkout', '--', 'a.txt');
    // The other file still applies on its own.
    const ok = await ctl.apply(run.id, { files: ['a.txt'] });
    assert.deepEqual([ok.applied, ok.remaining], [true, ['c.txt']]);
    assert.equal(read(repo, 'a.txt'), 'a (run 2)\n');
    assert.equal(read(repo, 'c.txt'), 'c (mine)\n');
    await ctl.discard(run.id);
  });

  test('a whole apply with no choice still merges the run branch', async () => {
    const run = await runWith('Whole', (w) => put(w, 'b.txt', 'b (whole)\n'));
    const r = await ctl.apply(run.id);
    assert.equal(r.applied, true);
    assert.match(g(repo, 'log', '--oneline', '-1'), /Merge orbix\//);
    assert.equal(ctl.store.get(run.id).accepted, undefined);
  });
});
