// Projects with several folders (parity 3.1): a main folder plus extra folders. Saving and loading (old config files
// load unchanged), file access in an extra folder and refused outside every folder, the read-only rule for extra
// folders in a worktree session (runs), the folder list in the system prompt, and the HTTP route. No network.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-multifolder-'));
process.env.ORBIX_NO_RG = '1';
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });
const CONFIG = path.join(process.env.ORBIX_DATA, 'config.json');

const { Store, projectFolders, projectOf } = await import('../src/store.mjs');
const { createTools, isForeignShare } = await import('../src/engine/tools.mjs');
const { AgentProc } = await import('../src/engine/proc.mjs');
const { buildSystemPrompt, environmentFacts, foldersLines } = await import('../src/engine/prompt.mjs');
const { AppServer } = await import('../src/server.mjs');
after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const main = path.join(TMP, 'app');
const lib = path.join(TMP, 'shared lib ñ');
const docs = path.join(TMP, 'docs');
const secret = path.join(TMP, 'secret');
before(() => {
  for (const d of [main, lib, docs, secret]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(lib, 'util.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(secret, 'key.txt'), 'nope\n');
});

describe('saving a project with several folders', () => {
  test('a project saved by an older version (one folder) loads unchanged, with no extra folders', () => {
    const old = { version: 1, backend: { kind: 'native', distro: '' }, backendChosen: true, workspaces: [{ id: 'w1', path: main, name: 'app', added: 1 }] };
    fs.writeFileSync(CONFIG, JSON.stringify(old));
    const st = new Store();
    assert.deepEqual(st.data.workspaces, old.workspaces); // nothing added on load
    assert.deepEqual(projectFolders(st.data.workspaces[0]), []);
    assert.deepEqual(projectFolders(undefined), []);
    assert.deepEqual(projectFolders({ folders: 'not a list' }), []);
  });

  test('extra folders are saved, survive a restart, and can be removed', () => {
    const st = new Store();
    st.addFolder('w1', lib);
    st.addFolder('w1', docs);
    st.addFolder('w1', lib.toUpperCase()); // the same folder again (Windows compares paths without case): kept once
    assert.deepEqual(st.data.workspaces[0].folders, [lib, docs]);
    assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).workspaces[0].folders, [lib, docs]);

    const again = new Store();
    assert.deepEqual(projectFolders(again.data.workspaces[0]), [lib, docs]);
    again.removeFolder('w1', docs + path.sep);
    assert.deepEqual(new Store().data.workspaces[0].folders, [lib]);
  });

  test('the main folder is not added as an extra folder; an unknown project is an error', () => {
    const st = new Store();
    assert.throws(() => st.addFolder('w1', main), /main folder/);
    assert.throws(() => st.addFolder('nope', lib), /No such project/);
    assert.throws(() => st.addFolder('w1', '  '), /Path required/);
  });

  test('a worktree of the project (run or branch session) finds the project it was cut from', () => {
    const list = [{ id: 'w1', path: 'C:\\Code\\app', folders: ['D:\\lib'] }, { id: 'w2', path: 'C:\\Code\\mono\\web' }];
    assert.equal(projectOf(list, 'c:/code/app/')?.id, 'w1');
    assert.equal(projectOf(list, 'C:\\Code\\app\\.orbix\\worktrees\\20261120-1200-abc')?.id, 'w1');
    assert.equal(projectOf(list, 'C:\\Code\\mono\\.orbix\\worktrees\\20261120-1200-abc\\web')?.id, 'w2');
    assert.equal(projectOf(list, 'C:\\Code\\other'), null);
    assert.equal(projectOf(list, ''), null);
  });
});

describe('file access across the project folders', () => {
  const backend = { hostPath: (p) => p };
  let folders = [lib];
  const T = createTools({ backend, cwd: main, folders: () => folders, getSignal: () => undefined });

  test('a path in an extra folder is inside the project; one outside every folder is not', () => {
    assert.equal(T.inProject('src/a.js'), true);
    assert.equal(T.inProject(path.join(lib, 'util.js')), true);
    assert.equal(T.inProject(lib), true);
    assert.equal(T.inProject(path.join(secret, 'key.txt')), false);
    assert.equal(T.inProject(`${lib}-other${path.sep}x.js`), false); // a sibling with the same prefix
    assert.equal(T.inProject('../secret/key.txt'), false);
    assert.equal(T.inProject(path.join(lib, 'util.js'), { mainOnly: true }), false);
  });

  test('removing a folder takes access away at once', () => {
    folders = [];
    assert.equal(T.inProject(path.join(lib, 'util.js')), false);
    folders = [lib];
  });

  test('the tools read and edit a file in an extra folder', async () => {
    const f = path.join(lib, 'util.js');
    const r = await T.run('read', { path: f }, {});
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /export const x = 1/);
    const e = await T.run('edit', { path: f, old_string: 'x = 1', new_string: 'x = 2' }, {});
    assert.equal(e.isError, undefined, e.text);
    assert.match(fs.readFileSync(f, 'utf8'), /x = 2/);
  });

  test('a network share is opened only when it is one of the project folders', async () => {
    const S = createTools({ backend, cwd: 'C:\\Code\\app', folders: ['\\\\nas\\team\\lib'] });
    assert.equal(isForeignShare('\\\\nas\\team\\lib\\a.txt', 'C:\\Code\\app'), true);
    assert.equal(S.inProject('\\\\nas\\team\\lib\\a.txt'), true);
    const r = await S.run('read', { path: '\\\\evil\\share\\a.txt' }, {});
    assert.equal(r.isError, true);
    assert.match(r.text, /Network paths are not opened/);
  });

  // The approval decision, as the agent makes it (same harness as test/harness.test.mjs).
  const ask = (approvals, name, p, { allow = [], worktree = null } = {}) =>
    AgentProc.prototype._mustAsk.call({ config: { data: { approvals, trusted: [] } }, allowAlways: new Set(allow), tools: T, worktree, _outside: AgentProc.prototype._outside, _needsApproval: (n) => ['write', 'edit', 'bash'].includes(n) }, { name }, { path: p });

  test('an extra folder has the same approval rules as the main folder', () => {
    const f = path.join(lib, 'util.js');
    assert.equal(ask('ask', 'read', f), false); // reads never ask inside the project
    assert.equal(ask('ask', 'grep', lib), false);
    assert.equal(ask('edits', 'edit', f), false); // Allow edits: edits run without asking
    assert.equal(ask('ask', 'edit', f), true); // Ask first: edits ask, as in the main folder
  });

  test('a path outside every project folder still asks every time', () => {
    const f = path.join(secret, 'key.txt');
    assert.equal(ask('ask', 'read', f), true);
    assert.equal(ask('edits', 'write', f), true);
    assert.equal(ask('edits', 'write', f, { allow: ['write'] }), true); // allowing writes does not cover outside paths
  });

  test('in a worktree session (a run) extra folders are read-only: reads go through, a write asks every time', () => {
    const worktree = { path: main, branch: 'orbix/x' };
    const f = path.join(lib, 'util.js');
    assert.equal(ask('ask', 'read', f, { worktree }), false);
    assert.equal(ask('ask', 'glob', lib, { worktree }), false);
    // A run's approved scope allows write and edit; that covers its worktree only.
    assert.equal(ask('ask', 'edit', f, { worktree, allow: ['write', 'edit'] }), true);
    assert.equal(ask('ask', 'write', path.join(main, 'new.js'), { worktree, allow: ['write', 'edit'] }), false);
    const title = AgentProc.prototype._askTitle.call({ tools: T, worktree, mcp: { has: () => false }, _outside: AgentProc.prototype._outside }, { name: 'edit', arguments: { path: f } });
    assert.match(title, /another project folder.*not part of what you review/);
  });
});

describe('the folder list in the agent context', () => {
  const env = { workspace: main, shell: 'cmd', os: 'Windows', date: '2026-11-20', git: null };

  test('the system prompt lists the extra folders under the project folder', () => {
    const text = buildSystemPrompt({ env: { ...env, folders: [lib, docs] }, model: '', approvals: 'ask' });
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('- Project folder: '));
    assert.ok(at >= 0);
    assert.match(lines[at + 1], /^- Other project folders \(read, search and edit them/);
    assert.equal(lines[at + 2], `  - ${lib}`);
    assert.equal(lines[at + 3], `  - ${docs}`);
  });

  test('a one-folder project has no folder list (the prompt is as before)', () => {
    const before = buildSystemPrompt({ env, model: '', approvals: 'ask' });
    assert.doesNotMatch(before, /Other project folders/);
    assert.equal(buildSystemPrompt({ env: { ...env, folders: [] }, model: '', approvals: 'ask' }), before);
  });

  test('in a worktree session the list says the extra folders are for reading', () => {
    assert.match(foldersLines({ folders: [lib], worktree: true })[0], /not part of this branch, so do not edit them/);
  });

  test('environment facts carry the folders', async () => {
    const facts = await environmentFacts({ isWsl: false }, main, { git: false, folders: [lib], worktree: false });
    assert.deepEqual(facts.folders, [lib]);
    assert.match(buildSystemPrompt({ env: facts, model: '' }), new RegExp(`  - ${lib.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});

describe('extra folders over HTTP', () => {
  const TOKEN = 'm'.repeat(48);
  let srv;
  let port;
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
    const store = new Store();
    store.data.backend = { kind: 'native', distro: '' };
    store.data.backendChosen = true;
    store.data.workspaces = [];
    srv = new AppServer({ store, token: TOKEN });
    port = await srv.listen(0);
  });
  after(async () => {
    await srv?.shutdown();
  });

  test('add and remove a folder; a conversation in the project can work there', async () => {
    const w = (await api('POST', '/api/workspaces', { path: main })).json.workspace;
    let r = await api('POST', '/api/workspaces/folders', { id: w.id, path: lib });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.workspaces.find((x) => x.id === w.id).folders, [lib]);
    assert.equal((await api('POST', '/api/workspaces/folders', { id: w.id, path: path.join(TMP, 'missing') })).status, 400);
    assert.equal((await api('POST', '/api/workspaces/folders', { id: w.id, path: main })).status, 400);
    assert.equal((await api('POST', '/api/workspaces/folders', { id: 'nope', path: lib })).status, 404);
    assert.deepEqual((await api('GET', '/api/state')).json.workspaces.find((x) => x.id === w.id).folders, [lib]);

    const p = await api('POST', '/api/proc/start', { workspace: main, noSession: true });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    const proc = srv.procs.get(p.json.id);
    assert.deepEqual(proc.folders(), [lib]);
    assert.equal(proc.tools.inProject(path.join(lib, 'util.js')), true);
    assert.equal(proc.tools.inProject(path.join(secret, 'key.txt')), false);
    assert.ok((await proc._system()).includes(`- Other project folders (read, search and edit them with absolute paths, with the same approvals as the project folder):\n  - ${lib}`));

    r = await api('POST', '/api/workspaces/folders', { id: w.id, path: lib, remove: true });
    assert.deepEqual(r.json.workspaces.find((x) => x.id === w.id).folders, []);
    assert.equal(proc.tools.inProject(path.join(lib, 'util.js')), false); // the open conversation loses access at once
    await api('POST', '/api/proc/stop', { proc: p.json.id });
  });
});
