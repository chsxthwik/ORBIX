// Tests for sessions on their own branch: worktree add/list/remove, the branch diff, and merge (real git, scratch repo).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'tester';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';

const { Backend } = await import('../src/backend.mjs');
const gitapi = await import('../src/gitapi.mjs');

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('session branches', { skip: !gitAvailable && 'git not installed' }, () => {
  const backend = new Backend({ kind: 'native' });
  let root;
  let repo;
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
  const branches = () => g(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-wt-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    g(repo, 'init', '-q');
    g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    put(repo, 'a.txt', 'one\ntwo\nthree\n');
    put(repo, 'src/b.txt', 'b\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'start');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('slugs are short, safe and different', () => {
    const a = gitapi.worktreeSlug(new Date(2026, 10, 11, 14, 32));
    assert.match(a, /^20261111-1432-[a-z0-9]{3}$/);
    assert.notEqual(gitapi.worktreeSlug(), gitapi.worktreeSlug(), 'two at once must not collide (random part)');
  });

  test('repoInfo finds the top folder, the subfolder, the commit and the branch', async () => {
    const top = await gitapi.repoInfo(backend, repo);
    assert.equal(path.resolve(top.repo), path.resolve(repo));
    assert.equal(top.prefix, '');
    assert.equal(top.branch, 'main');
    assert.match(top.head, /^[0-9a-f]{40}$/);
    const sub = await gitapi.repoInfo(backend, path.join(repo, 'src'));
    assert.equal(path.resolve(sub.repo), path.resolve(repo));
    assert.equal(sub.prefix, 'src');
    const plain = fs.mkdtempSync(path.join(root, 'plain-'));
    assert.equal(await gitapi.repoInfo(backend, plain), null);
  });

  test('a repository without a commit is refused', async () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    g(empty, 'init', '-q');
    await assert.rejects(gitapi.worktreeAdd(backend, empty), /first commit/);
    await assert.rejects(gitapi.worktreeAdd(backend, fs.mkdtempSync(path.join(root, 'nogit-'))), /not a git repository/);
  });

  test('two sessions get their own worktree and branch, cut from HEAD; the main checkout stays clean', async () => {
    const head = g(repo, 'rev-parse', 'HEAD').trim();
    const a = await gitapi.worktreeAdd(backend, repo, { slug: 'one' });
    const b = await gitapi.worktreeAdd(backend, path.join(repo, 'src'), { slug: 'two' });
    assert.equal(a.branch, 'orbix/one');
    assert.equal(a.base, head);
    assert.equal(a.baseBranch, 'main');
    assert.equal(path.resolve(a.path), path.join(repo, '.orbix', 'worktrees', 'one'));
    assert.equal(path.resolve(a.workspace), path.resolve(a.path));
    assert.equal(path.resolve(b.workspace), path.join(repo, '.orbix', 'worktrees', 'two', 'src'), 'a session started in a subfolder works in that subfolder');
    assert.equal(read(a.path, 'a.txt'), 'one\ntwo\nthree\n');
    assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\/\.orbix\/worktrees\/$/m);
    assert.equal(g(repo, 'status', '--porcelain'), '', 'the worktrees folder is not listed as untracked');
    // Adding a second one does not repeat the exclude line.
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('/.orbix/worktrees/').length, 2);
    const list = await gitapi.listWorktrees(backend, repo);
    assert.deepEqual(list.map((w) => w.branch).sort(), ['main', 'orbix/one', 'orbix/two']);
    await assert.rejects(gitapi.worktreeAdd(backend, a.path, { slug: 'nested' }), /already a session branch/);
    await assert.rejects(gitapi.worktreeAdd(backend, repo, { slug: '../evil' }), (e) => e.status === 400);
    await assert.rejects(gitapi.worktreeAdd(backend, repo, { slug: '-b' }), (e) => e.status === 400);
  });

  test('the branch diff lists edits, new files and commits against the base', async () => {
    const wt = path.join(repo, '.orbix', 'worktrees', 'one');
    const base = g(repo, 'rev-parse', 'main').trim();
    let d = await gitapi.branchDiff(backend, wt, base);
    assert.deepEqual([d.files.length, d.commits, d.pending], [0, 0, false]);
    put(wt, 'a.txt', 'one\nTWO\nthree\n');
    put(wt, 'new dir/n.txt', 'x\ny\n');
    d = await gitapi.branchDiff(backend, wt, base);
    assert.deepEqual(d.files.map((f) => [f.path, f.status, f.add, f.del, f.untracked]), [['a.txt', 'M', 1, 1, false], ['new dir/n.txt', 'A', 2, 0, true]]);
    assert.equal(d.pending, true);
    g(wt, 'add', 'a.txt');
    g(wt, 'commit', '-qm', 'edit a');
    d = await gitapi.branchDiff(backend, wt, base);
    assert.equal(d.commits, 1);
    assert.equal(d.files.find((f) => f.path === 'a.txt').status, 'M', 'committed edits still show against the base');
    assert.match((await gitapi.branchFileDiff(backend, wt, base, 'a.txt')).text, /-two\n\+TWO/);
    assert.match((await gitapi.branchFileDiff(backend, wt, base, 'new dir/n.txt', { untracked: true })).text, /\+x\n\+y/);
    await assert.rejects(gitapi.branchFileDiff(backend, wt, base, '../x'), (e) => e.status === 400);
    await assert.rejects(gitapi.branchDiff(backend, wt, 'HEAD; rm -rf /'), (e) => e.status === 400);
  });

  test('merge refuses a dirty main checkout or another branch there, and changes nothing', async () => {
    const wt = path.join(repo, '.orbix', 'worktrees', 'one');
    const before = g(repo, 'rev-parse', 'HEAD').trim();
    put(repo, 'a.txt', 'dirty\n');
    await assert.rejects(gitapi.merge(backend, { repo, wt, slug: 'one', baseBranch: 'main' }), (e) => e.status === 409 && /uncommitted/.test(e.message));
    g(repo, 'checkout', '-q', '--', 'a.txt');
    g(repo, 'checkout', '-q', '-b', 'other');
    await assert.rejects(gitapi.merge(backend, { repo, wt, slug: 'one', baseBranch: 'main' }), (e) => e.status === 409 && /on other, not main/.test(e.message));
    g(repo, 'checkout', '-q', 'main');
    g(repo, 'branch', '-q', '-D', 'other');
    assert.equal(g(repo, 'rev-parse', 'HEAD').trim(), before);
    assert.deepEqual((await gitapi.status(backend, wt)).files.map((f) => [f.path, f.untracked]), [['new dir/n.txt', true]], 'the session folder is as it was');
  });

  test('merge commits pending edits on the branch, then merges with a merge commit', async () => {
    const wt = path.join(repo, '.orbix', 'worktrees', 'one');
    const r = await gitapi.merge(backend, { repo, wt, slug: 'one', baseBranch: 'main', message: 'Session one' });
    assert.equal(r.merged, true);
    assert.equal(r.committed, true);
    assert.equal(g(repo, 'rev-parse', 'HEAD').trim(), r.hash);
    assert.equal(g(repo, 'log', '-1', '--pretty=%P').trim().split(' ').length, 2, 'a merge commit (--no-ff)');
    assert.equal(g(repo, 'log', '-1', '--pretty=%s').trim(), 'Merge orbix/one into main');
    assert.equal(read(repo, 'a.txt'), 'one\nTWO\nthree\n');
    assert.equal(read(repo, 'new dir/n.txt'), 'x\ny\n');
    assert.equal(g(wt, 'log', '-1', '--pretty=%s').trim(), 'Session one');
    assert.deepEqual((await gitapi.status(backend, repo)).files, []);
    await assert.rejects(gitapi.merge(backend, { repo, wt, slug: 'one', baseBranch: 'main' }), /Nothing to merge/);
  });

  test('a conflict is aborted and both checkouts stay as they were', async () => {
    const wt = path.join(repo, '.orbix', 'worktrees', 'two');
    put(wt, 'a.txt', 'one\nsecond session\nthree\n'); // main now has TWO on this line
    const mainHead = g(repo, 'rev-parse', 'HEAD').trim();
    const branchHead = g(wt, 'rev-parse', 'HEAD').trim();
    const r = await gitapi.merge(backend, { repo, wt, slug: 'two', baseBranch: 'main', message: 'Session two' });
    assert.equal(r.merged, false);
    assert.equal(r.conflict, true);
    assert.deepEqual(r.files, ['a.txt']);
    assert.equal(g(repo, 'rev-parse', 'HEAD').trim(), mainHead);
    // Status through gitapi: the same git settings (line endings) as the merge itself.
    assert.deepEqual((await gitapi.status(backend, repo)).files, [], 'no merge left half-done in the project folder');
    assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false);
    assert.equal(g(wt, 'rev-parse', 'HEAD').trim(), branchHead, 'the commit made for the merge is taken back');
    assert.equal(read(wt, 'a.txt'), 'one\nsecond session\nthree\n', 'the session edit is still there');
    assert.deepEqual((await gitapi.status(backend, wt)).files.map((f) => [f.path, f.unstaged]), [['a.txt', true]]);
  });

  test('remove deletes the worktree and its branch; a folder already gone is fine too', async () => {
    await gitapi.worktreeRemove(backend, { repo, slug: 'two' });
    assert.equal(fs.existsSync(path.join(repo, '.orbix', 'worktrees', 'two')), false);
    assert.deepEqual(branches(), ['main', 'orbix/one']);
    fs.rmSync(path.join(repo, '.orbix', 'worktrees', 'one'), { recursive: true, force: true });
    await gitapi.worktreeRemove(backend, { repo, slug: 'one' });
    assert.deepEqual(branches(), ['main']);
    assert.deepEqual((await gitapi.listWorktrees(backend, repo)).map((w) => w.branch), ['main']);
    await assert.rejects(gitapi.worktreeRemove(backend, { repo, slug: '../../x' }), (e) => e.status === 400);
  });

  test('git worktree list parser', () => {
    const text = 'worktree /r\0HEAD abc\0branch refs/heads/main\0\0worktree /r/.orbix/worktrees/x\0HEAD def\0detached\0locked\0\0';
    assert.deepEqual(gitapi.parseWorktrees(text), [
      { path: '/r', head: 'abc', branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/r/.orbix/worktrees/x', head: 'def', branch: '', detached: true, bare: false, locked: true, prunable: false },
    ]);
  });
});
