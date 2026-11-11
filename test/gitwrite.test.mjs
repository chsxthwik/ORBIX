// Tests for the Changes panel's git writes: stage, unstage, discard, commit (real git, scratch repo).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Stop git from discovering a repository above the scratch dir, and give commits an identity.
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

describe('git writes', { skip: !gitAvailable && 'git not installed' }, () => {
  const backend = new Backend({ kind: 'native' });
  let root;
  let repo;
  const g = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  // Windows git may check files out with CRLF (core.autocrlf): compare text without the line-ending difference.
  const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
  const files = async () => Object.fromEntries((await gitapi.status(backend, repo)).files.map((f) => [f.path, f]));

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-gitw-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    g('init', '-q');
    g('symbolic-ref', 'HEAD', 'refs/heads/main');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('stage, unstage (before the first commit) and commit', async () => {
    put('a.txt', 'one\n');
    put('sub dir/b ü.txt', 'two\n');
    await gitapi.stage(backend, repo, ['a.txt', 'sub dir/b ü.txt']);
    let f = await files();
    assert.equal(f['a.txt'].staged, true);
    assert.equal(f['sub dir/b ü.txt'].staged, true);

    await gitapi.unstage(backend, repo, ['a.txt']); // no HEAD yet
    f = await files();
    assert.equal(f['a.txt'].untracked, true);
    assert.equal(f['sub dir/b ü.txt'].staged, true);

    await gitapi.stage(backend, repo, ['a.txt']);
    const c = await gitapi.commit(backend, repo, '  first commit  ');
    assert.match(c.hash, /^[0-9a-f]{7,}$/);
    assert.equal(g('log', '-1', '--pretty=%s').trim(), 'first commit');
    assert.deepEqual(Object.keys(await files()), []);
  });

  test('unstage after a commit keeps the edit in the working tree', async () => {
    put('a.txt', 'one\nchanged\n');
    await gitapi.stage(backend, repo, ['a.txt']);
    assert.equal((await files())['a.txt'].staged, true);
    await gitapi.unstage(backend, repo, ['a.txt']);
    const f = (await files())['a.txt'];
    assert.deepEqual([f.staged, f.unstaged], [false, true]);
    assert.equal(read('a.txt'), 'one\nchanged\n');
  });

  test('discard restores tracked files and deletes untracked ones', async () => {
    put('new.txt', 'scratch');
    await gitapi.discard(backend, repo, { tracked: ['a.txt'], untracked: ['new.txt'] });
    assert.equal(read('a.txt'), 'one\n');
    assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false);
    assert.deepEqual(Object.keys(await files()), []);
  });

  test('discard leaves the staged part of a file alone', async () => {
    put('a.txt', 'staged\n');
    await gitapi.stage(backend, repo, ['a.txt']);
    put('a.txt', 'staged\nand more\n');
    await gitapi.discard(backend, repo, { tracked: ['a.txt'] });
    assert.equal(read('a.txt'), 'staged\n');
    assert.equal((await files())['a.txt'].staged, true);
    await gitapi.commit(backend, repo, 'second');
  });

  test('a commit needs a message and something staged', async () => {
    await assert.rejects(gitapi.commit(backend, repo, '   '), /commit message/);
    await assert.rejects(gitapi.commit(backend, repo, 'nothing here'), /nothing|no changes/i);
  });

  test('repository hooks are not run by a commit', async () => {
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    put('c.txt', 'c\n');
    await gitapi.stage(backend, repo, ['c.txt']);
    await gitapi.commit(backend, repo, 'hook would have refused this');
    assert.equal(g('log', '-1', '--pretty=%s').trim(), 'hook would have refused this');
  });

  test('paths outside the project or shaped like options are refused', async () => {
    for (const bad of [['../x'], ['a/../../x'], ['/etc/passwd'], ['C:\\Windows'], ['a\0b'], [''], []]) {
      await assert.rejects(gitapi.stage(backend, repo, bad), (e) => e.status === 400, JSON.stringify(bad));
    }
    await assert.rejects(gitapi.discard(backend, repo, {}), (e) => e.status === 400);
    await assert.rejects(gitapi.unstage(backend, repo, '--all'), (e) => e.status === 400);
    // a name that looks like an option is passed after `--`, so it is just a (missing) file
    put('-n.txt', 'x\n');
    await gitapi.stage(backend, repo, ['-n.txt']);
    assert.equal((await files())['-n.txt'].staged, true);
  });

  test('paths are literal: a name with wildcard or pathspec characters touches only that file', async () => {
    put('a.txt.keep', 'keep\n');
    put('[a].txt', 'bracket\n');
    put('a.txt', 'plain\n');
    await gitapi.discard(backend, repo, { untracked: ['[a].txt'] });
    assert.equal(fs.existsSync(path.join(repo, '[a].txt')), false);
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), true, '"[a].txt" must not also match "a.txt"');
    // ":/" is pathspec magic for "the whole repository"
    await gitapi.discard(backend, repo, { untracked: [':/'] }).catch(() => {});
    assert.equal(fs.existsSync(path.join(repo, 'a.txt.keep')), true);
    assert.equal(fs.existsSync(path.join(repo, 'a.txt')), true);
  });
});

describe('programs named by a repository\'s own config never run', { skip: !gitAvailable && 'git not installed' }, () => {
  const backend = new Backend({ kind: 'native' });
  let root;
  let repo;
  let mark;
  const g = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const ran = () => (fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : '');

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-gitevil-'));
    repo = path.join(root, 'repo');
    mark = path.join(root, 'ran.txt');
    const m = mark.replace(/\\/g, '/');
    fs.mkdirSync(repo);
    g('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    g('add', 'a.txt');
    g('commit', '-qm', 'one');
    // A HEAD commit with a signature, so `log` with log.showSignature would call gpg.program.
    const tree = g('write-tree').trim();
    const obj = `tree ${tree}\nparent ${g('rev-parse', 'HEAD').trim()}\nauthor t <t@e> 1 +0000\ncommitter t <t@e> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nsigned\n`;
    const sha = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: obj, encoding: 'utf8' }).trim();
    g('update-ref', 'HEAD', sha);
    const hooks = path.join(root, 'hooks');
    fs.mkdirSync(hooks);
    for (const h of ['prepare-commit-msg', 'post-commit', 'post-index-change', 'reference-transaction', 'post-checkout']) fs.writeFileSync(path.join(hooks, h), `#!/bin/sh\necho hook-${h} >> '${m}'\n`, { mode: 0o755 });
    const gpg = path.join(root, 'gpg.sh');
    fs.writeFileSync(gpg, `#!/bin/sh\necho gpg >> '${m}'\n`, { mode: 0o755 });
    g('config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
    g('config', 'gpg.program', gpg.replace(/\\/g, '/'));
    g('config', 'log.showSignature', 'true');
    g('config', 'filter.evil.clean', `echo filter >> '${m}'; cat`);
    g('config', 'filter.evil.smudge', `echo filter >> '${m}'; cat`);
    g('config', 'filter.evil.required', 'true');
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('status, diff, stage, unstage, discard and commit run no repo filter, hook or signing program', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    const st = await gitapi.status(backend, repo);
    assert.deepEqual(st.files.map((f) => f.path).sort(), ['a.txt', 'b.txt']);
    assert.match((await gitapi.diff(backend, repo, 'a.txt')).text, /\+two/);
    await gitapi.stage(backend, repo, ['a.txt', 'b.txt']);
    await gitapi.unstage(backend, repo, ['b.txt']);
    await gitapi.discard(backend, repo, { untracked: ['b.txt'] });
    await gitapi.commit(backend, repo, 'two');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    await gitapi.discard(backend, repo, { tracked: ['a.txt'] });
    assert.equal(ran(), '');
    // Control: plain git with this config does run them, so the checks above mean something.
    g('log', '-2');
    assert.match(ran(), /gpg/);
  });

  test('a filter name git cannot be told to switch off makes git refuse to run there', async () => {
    const other = path.join(root, 'odd');
    fs.mkdirSync(other);
    execFileSync('git', ['init', '-q'], { cwd: other });
    execFileSync('git', ['config', 'filter.a=b.clean', 'cat'], { cwd: other });
    await assert.rejects(gitapi.status(backend, other), /cannot switch off/);
  });
});
