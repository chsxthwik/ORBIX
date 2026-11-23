// The Changes panel's ship path: lines added and removed per file, the patch excerpt a message is written from, the
// remote's web address, and a real push to a local bare remote (real git, scratch repos).
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
const { prUrl, splitMessage, joinMessage } = await import('../web/js/pr-link.mjs');

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('a remote address gives its web address and host', () => {
  assert.deepEqual(gitapi.parseRemote('https://github.com/acme/shop.git'), { host: 'github', web: 'https://github.com/acme/shop' });
  assert.deepEqual(gitapi.parseRemote('git@github.com:acme/shop.git'), { host: 'github', web: 'https://github.com/acme/shop' });
  assert.deepEqual(gitapi.parseRemote('https://user:token@github.com/acme/shop'), { host: 'github', web: 'https://github.com/acme/shop' });
  assert.deepEqual(gitapi.parseRemote('ssh://git@gitlab.com/group/sub/app.git'), { host: 'gitlab', web: 'https://gitlab.com/group/sub/app' });
  assert.deepEqual(gitapi.parseRemote('https://git.example.org/team/app.git'), { host: '', web: 'https://git.example.org/team/app' });
  assert.deepEqual(gitapi.parseRemote('C:\\repos\\origin.git'), { host: '', web: '' });
  assert.deepEqual(gitapi.parseRemote(''), { host: '', web: '' });
});

test('the pull request link carries the title and body, and stays short enough for a browser', () => {
  const g = prUrl({ host: 'github', web: 'https://github.com/acme/shop', branch: 'orbix/20261123-1', base: 'main', title: 'Lock an email after 5 failed sign-ins', body: 'Adds `limit.js`.\n\n- tests' });
  assert.ok(g.startsWith('https://github.com/acme/shop/compare/main...orbix%2F20261123-1?'));
  const q = new URL(g).searchParams;
  assert.equal(q.get('quick_pull'), '1');
  assert.equal(q.get('title'), 'Lock an email after 5 failed sign-ins');
  assert.equal(q.get('body'), 'Adds `limit.js`.\n\n- tests');
  const big = prUrl({ host: 'github', web: 'https://github.com/a/b', branch: 'x', base: 'main', title: 't', body: 'x'.repeat(20000) });
  assert.ok(big.length < 7000, `${big.length} characters`);
  const gl = prUrl({ host: 'gitlab', web: 'https://gitlab.com/g/p', branch: 'feat', base: 'main', title: 'T', body: 'B' });
  assert.ok(gl.startsWith('https://gitlab.com/g/p/-/merge_requests/new?'));
  assert.equal(new URL(gl).searchParams.get('merge_request[source_branch]'), 'feat');
  assert.equal(prUrl({ host: '', web: 'https://git.example.org/t/a', branch: 'x', base: 'main', title: 't', body: 'b' }), '');
});

test('a written title and body are split and joined back', () => {
  assert.deepEqual(splitMessage('Lock an email after 5 failed sign-ins.\n\nAdds `limit.js`.\n- tests'), { title: 'Lock an email after 5 failed sign-ins', body: 'Adds `limit.js`.\n- tests' });
  assert.deepEqual(splitMessage('**Title:** "Fix reset links"\n\n**Body:**\nThe TTL was a minute.'), { title: 'Fix reset links', body: 'The TTL was a minute.' });
  assert.deepEqual(splitMessage('```\n# Add health check\n\nBody\n```'), { title: 'Add health check', body: 'Body' });
  assert.equal(splitMessage('x'.repeat(100)).title.length, 72);
  assert.deepEqual(splitMessage(''), { title: '', body: '' });
  assert.equal(joinMessage(' T ', ' B '), 'T\n\nB');
  assert.equal(joinMessage('T', ''), 'T');
});

describe('numstat, patch and push', { skip: !gitAvailable && 'git not installed' }, () => {
  const backend = new Backend({ kind: 'native' });
  let root, repo, remote;
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-ship-'));
    repo = path.join(root, 'repo');
    remote = path.join(root, 'origin.git');
    fs.mkdirSync(repo);
    fs.mkdirSync(remote);
    g(remote, 'init', '-q', '--bare', '-b', 'main');
    g(repo, 'init', '-q', '-b', 'main');
    put('a.txt', 'one\ntwo\nthree\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'first');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('lines added and removed per file, with new files counted as all added', async () => {
    put('a.txt', 'one\nTWO\nthree\nfour\n');
    put('b.txt', 'x\ny\n');
    const st = await gitapi.status(backend, repo);
    const stats = await gitapi.numstat(backend, repo, st.files.filter((f) => f.untracked).map((f) => f.path));
    assert.deepEqual(stats['a.txt'], [2, 1]);
    assert.deepEqual(stats['b.txt'], [2, 0]);
  });

  test('the patch excerpt holds the changes and is cut to length', async () => {
    const p = await gitapi.patch(backend, repo, 200);
    assert.match(p.text, /^diff --git a\/a\.txt/);
    assert.ok(p.text.length <= 200);
    assert.equal((await gitapi.patch(backend, repo)).truncated, false);
  });

  test('push without a remote says what to do', async () => {
    await assert.rejects(() => gitapi.push(backend, repo), /no remote/);
  });

  test('commit and push set the upstream and report the branch', async () => {
    g(repo, 'remote', 'add', 'origin', remote);
    await gitapi.stage(backend, repo, ['a.txt', 'b.txt']);
    const c = await gitapi.commit(backend, repo, 'Change a, add b\n\nBody line.');
    assert.match(c.hash, /^[0-9a-f]{7,}$/);
    const r = await gitapi.push(backend, repo);
    assert.equal(r.branch, 'main');
    assert.equal(r.remote, 'origin');
    assert.equal(g(remote, 'log', '-1', '--format=%s', 'main').trim(), 'Change a, add b');
    // a second push needs no upstream setup
    put('c.txt', 'c\n');
    await gitapi.stage(backend, repo, ['c.txt']);
    await gitapi.commit(backend, repo, 'Add c');
    await gitapi.push(backend, repo);
    assert.equal(g(remote, 'log', '-1', '--format=%s', 'main').trim(), 'Add c');
  });

  test('a detached HEAD cannot be pushed', async () => {
    g(repo, 'checkout', '-q', '--detach');
    await assert.rejects(() => gitapi.push(backend, repo), /detached HEAD/);
  });
});
