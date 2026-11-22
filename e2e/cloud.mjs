// ORBIX Cloud end to end, on Linux or macOS (where src/headless.mjs runs): two headless ORBIX servers, A and B, with
// a scripted model. A conversation on A runs a bash step, A adds B as a machine with its token, moves the
// conversation there with its project (git history and uncommitted files included), and it continues on B.
//
//   node e2e/cloud.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, startModel, writeConfig } from './lib.mjs';

if (process.platform === 'win32') {
  console.log('cloud e2e: runs on Linux or macOS (ORBIX Cloud); use WSL on Windows.');
  process.exit(0);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-cloud-e2e-'));
const repo = makeRepo(path.join(root, 'proj'));
fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'work in progress\n');
const model = await startModel();
const servers = [];
const say = (s) => console.log(`cloud e2e: ${s}`);

async function start(name, port, projects) {
  const data = path.join(root, name);
  writeConfig(data, model.port, projects);
  const ef = path.join(data, 'engine.json');
  fs.writeFileSync(ef, JSON.stringify({ ...JSON.parse(fs.readFileSync(ef, 'utf8')), approvals: 'auto' }));
  const home = path.join(root, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'headless.mjs')], { env: { ...process.env, HOME: home, ORBIX_DATA: data, ORBIX_LISTEN: `127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'inherit'] });
  servers.push(p);
  await new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => /is running/.test(d) && resolve());
    p.on('exit', (c) => reject(new Error(`${name} exited (${c})`)));
  });
  const token = fs.readFileSync(path.join(data, 'server-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${port}`;
  const H = { authorization: `Bearer ${token}`, 'x-orbix': '1', 'content-type': 'application/json' };
  const api = async (p2, b) => {
    const r = await (await fetch(base + p2, b === undefined ? { headers: H } : { method: 'POST', headers: H, body: JSON.stringify(b) })).json();
    if (!r.ok) throw new Error(`${name} ${p2}: ${r.error}`);
    return r;
  };
  const turn = async (proc, message) => {
    const msgs = async () => (await api('/api/rpc', { proc, cmd: { type: 'get_messages' } })).response.data.messages;
    const before = (await msgs()).length;
    await api('/api/rpc', { proc, cmd: { type: 'prompt', message } });
    for (let i = 0; i < 400; i++) {
      const st = (await api('/api/rpc', { proc, cmd: { type: 'get_state' } })).response.data;
      const m = await msgs();
      if (!st.isStreaming && m.length > before + 1) return m;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the turn did not end');
  };
  return { api, turn, base, token };
}

let ok = false;
try {
  const A = await start('A', 47994, [repo]);
  const B = await start('B', 47995, []);
  const noAuth = await fetch(`${A.base}/api/state`);
  if (noAuth.status !== 401) throw new Error(`a request without the token got ${noAuth.status}`);
  say('servers up; a request without the token is refused');
  const p = await A.api('/api/proc/start', { workspace: repo });
  const m1 = await A.turn(p.id, 'Show activity after a partial reply');
  const tool = m1.find((m) => m.role === 'toolResult');
  if (!tool || tool.isError) throw new Error('the bash step did not run');
  say(`conversation on A: ${m1.map((m) => m.role).join(' → ')}`);
  const machines = (await A.api('/api/machines', { name: 'B', url: B.base, token: B.token })).machines;
  const tp = await A.api('/api/teleport', { proc: p.id, machine: machines[0].id });
  const files = fs.readdirSync(tp.workspace);
  if (!files.includes('.git') || !files.includes('uncommitted.txt')) throw new Error(`project files on B: ${files.join(' ')}`);
  if ((await A.api('/api/procs')).procs.length) throw new Error('the conversation is still open on A');
  say(`moved to B (${tp.bytes} bytes): ${files.join(' ')}`);
  const onB = (await B.api('/api/rpc', { proc: tp.proc, cmd: { type: 'get_messages' } })).response.data.messages.length;
  if (onB !== m1.length) throw new Error(`B has ${onB} messages, A had ${m1.length}`);
  const m2 = await B.turn(tp.proc, 'Fix capital letters in the greeting');
  say(`continued on B: ${onB} → ${m2.length} messages`);
  ok = true;
} catch (e) {
  console.log(`cloud e2e: FAILED — ${e.message}`);
} finally {
  for (const s of servers) s.kill('SIGTERM');
  model.server.close();
  await new Promise((r) => setTimeout(r, 800));
  fs.rmSync(root, { recursive: true, force: true });
}
say(ok ? 'passed' : 'failed');
process.exit(ok ? 0 : 1);
