// Sessions on their own branch through the real server: start in a worktree, review, keep, merge, discard (scratch repo).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-branch-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
process.env.GIT_CEILING_DIRECTORIES = os.tmpdir();
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'tester';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;
const { Store } = await import(SRC('store.mjs'));
const { AppServer } = await import(SRC('server.mjs'));
const { createSession, loadSession, appendEntry, closeSession } = await import(SRC('engine/store.mjs'));

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TOKEN = 'b'.repeat(48);

describe('branch sessions over HTTP', { skip: !gitAvailable && 'git not installed' }, () => {
  let srv;
  let port;
  const repo = path.join(TMP, 'repo');
  const g = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const branches = () => g(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
  const api = (method, p, body) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const headers = { host: `127.0.0.1:${port}`, cookie: `orbix=${TOKEN}`, ...(method === 'GET' ? {} : { 'x-orbix': '1', 'content-type': 'application/json' }) };
      if (data) headers['content-length'] = Buffer.byteLength(data);
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      r.on('error', reject);
      r.end(data);
    });

  before(async () => {
    fs.mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q');
    g(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'start');
    const store = new Store();
    store.data.backend = { kind: 'native', distro: '' };
    store.data.backendChosen = true;
    srv = new AppServer({ store, token: TOKEN });
    port = await srv.listen(0);
  });
  after(async () => {
    await srv?.shutdown();
    await new Promise((res) => setTimeout(res, 300)); // the exit handlers' git calls finish first
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test('a session started with branch works in its own worktree; the board data carries the branch', async () => {
    const r = await api('POST', '/api/proc/start', { workspace: repo, branch: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.match(r.json.worktree.branch, /^orbix\/\d{8}-\d{4}-[a-z0-9]{3}$/);
    assert.equal(r.json.worktree.baseBranch, 'main');
    assert.equal(path.dirname(r.json.workspace), path.join(repo, '.orbix', 'worktrees'));
    assert.ok(fs.existsSync(path.join(r.json.workspace, 'a.txt')));
    const procs = (await api('GET', '/api/procs')).json.procs;
    assert.equal(procs.find((p) => p.id === r.json.id).worktree.branch, r.json.worktree.branch);
    assert.equal(procs.find((p) => p.id === r.json.id).waiting, false);
  });

  test('a branch session closed with nothing in it leaves no branch behind', async () => {
    const r = await api('POST', '/api/proc/start', { workspace: repo, branch: true });
    const br = r.json.worktree.branch;
    assert.ok(branches().includes(br));
    await api('POST', '/api/proc/stop', { proc: r.json.id });
    for (let i = 0; i < 50 && branches().includes(br); i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(!branches().includes(br));
    assert.equal(fs.existsSync(path.join(repo, '.orbix', 'worktrees', br.slice(6))), false);
  });

  test('review lists the work; keep marks it; merge and discard need confirmation; merge lands it in main', async () => {
    const r = await api('POST', '/api/proc/start', { workspace: repo, branch: true });
    const id = r.json.id;
    fs.writeFileSync(path.join(r.json.workspace, 'b.txt'), 'from the session\n');
    let rv = await api('GET', `/api/branch?proc=${id}`);
    assert.deepEqual(rv.json.files.map((f) => [f.path, f.untracked]), [['b.txt', true]]);
    assert.deepEqual([rv.json.pending, rv.json.ahead, rv.json.main.branch, rv.json.main.dirty], [true, 0, 'main', false]);
    const d = await api('GET', `/api/branch/diff?proc=${id}&file=b.txt&untracked=1`);
    assert.match(d.json.diff.text, /\+from the session/);

    const k = await api('POST', '/api/branch/keep', { proc: id });
    assert.equal(k.json.worktree.state, 'kept');

    assert.equal((await api('POST', '/api/branch/merge', { proc: id })).status, 400, 'merge without confirm');
    assert.equal((await api('POST', '/api/branch/discard', { proc: id })).status, 400, 'discard without confirm');
    assert.ok(fs.existsSync(path.join(r.json.workspace, 'b.txt')));

    const m = await api('POST', '/api/branch/merge', { proc: id, confirm: true });
    assert.equal(m.status, 200, JSON.stringify(m.json));
    assert.equal(m.json.result.merged, true);
    assert.equal(m.json.worktree.state, 'merged');
    assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'from the session\n');
    rv = await api('GET', `/api/branch?proc=${id}`);
    assert.deepEqual([rv.json.pending, rv.json.ahead], [false, 0], 'nothing left to merge');

    const x = await api('POST', '/api/branch/discard', { proc: id, confirm: true });
    assert.equal(x.status, 200, JSON.stringify(x.json));
    assert.equal(fs.existsSync(r.json.workspace), false);
    assert.ok(!branches().includes(r.json.worktree.branch));
    assert.equal((await api('GET', `/api/branch?proc=${id}`)).status, 410, 'the session is closed');
  });

  test('a session in the project folder has no review', async () => {
    const r = await api('POST', '/api/proc/start', { workspace: repo });
    assert.equal(r.json.worktree, null);
    assert.equal((await api('GET', `/api/branch?proc=${r.json.id}`)).status, 400);
    await api('POST', '/api/proc/stop', { proc: r.json.id });
  });

  test('outside a git repository the branch choice is refused with a clear message', async () => {
    const plain = fs.mkdtempSync(path.join(TMP, 'plain-'));
    const r = await api('POST', '/api/proc/start', { workspace: plain, branch: true });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not a git repository/);
  });

  test('the session file keeps the branch and what was done with it', () => {
    const wt = { repo, slug: 'x', path: path.join(repo, '.orbix', 'worktrees', 'x'), branch: 'orbix/x', base: 'a'.repeat(40), baseBranch: 'main', source: repo };
    const s = createSession({ cwd: wt.path, keyPath: wt.path, model: 'm', provider: 'p', worktree: wt });
    appendEntry(s.file, { type: 'worktree', state: 'merged', hash: 'b'.repeat(40), at: 1 });
    closeSession(s.file);
    const back = loadSession(s.file);
    assert.deepEqual(back.header.worktree, wt);
    assert.deepEqual(back.worktreeState, { state: 'merged', hash: 'b'.repeat(40), at: 1 });
  });
});
