// ORBIX Cloud, the app side and the server side.
//
// Machines (Settings → Machines): other ORBIX servers you run, on a VPS or another computer (src/headless.mjs). Each
// is an address and its token; the token is stored encrypted like an API key and only sent to that address. The app
// window can switch to a machine, and back to this PC.
//
// Teleport: move a conversation to a machine. Its project goes as a gzip tarball (git history included; dependency
// and build folders left out), its saved conversation as text; the machine unpacks the project into
// ~/orbix-projects/<name>, registers it, and reopens the conversation there, where it keeps working while this PC
// sleeps. A conversation on another agent CLI that cannot carry its own session over is told what happened so far.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DATA_DIR } from './store.mjs';
import { readJson, writeJson, log, uid, VERSION } from './util.mjs';
import { protect, unprotect } from './engine/secrets.mjs';
import { appendEntry, importSession, loadSession } from './engine/store.mjs';
import { killTree } from './backend.mjs';

const FILE = () => path.join(DATA_DIR, 'machines.json');
const MAX_BUNDLE = 1024 * 1024 * 1024; // 1 GB of compressed project at most
const SKIP = ['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.nuxt', 'target', '.turbo', '.cache', '.gradle', '.parcel-cache', 'coverage'];

/** A machine address as ORBIX keeps it: http(s)://host[:port], no path, no token. */
export function cleanUrl(u) {
  let x;
  try {
    x = new URL(String(u || '').trim());
  } catch {
    throw Object.assign(new Error('Enter the address of the machine, like https://orbix.example.com or http://my-server:47821'), { status: 400 });
  }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') throw Object.assign(new Error('The address must start with https:// or http://'), { status: 400 });
  const local = /^(127\.|localhost$|\[?::1\]?$)/.test(x.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(x.hostname) || x.hostname.endsWith('.ts.net') || !x.hostname.includes('.');
  if (x.protocol === 'http:' && !local) throw Object.assign(new Error('Use https:// for a machine on the internet: the token would otherwise travel unencrypted. Plain http:// is fine on your own network or Tailscale.'), { status: 400 });
  return x.origin;
}

/** Tar a project folder into a gzip stream. Runs where the project is (WSL or Windows tar). */
function tarProject(backend, folder) {
  const args = ['-czf', '-', ...SKIP.flatMap((s) => [`--exclude=${s}`]), '-C', backend.execPath(folder), '.'];
  return backend.spawn(['tar', ...args], { quiet: true });
}

export class Machines {
  constructor(server) {
    this.s = server;
    this.list = (readJson(FILE(), []) || []).filter((m) => m?.id && m?.url && m?.token);
  }

  save() {
    writeJson(FILE(), this.list);
  }

  view() {
    return this.list.map(({ id, name, url, addedAt, lastSeen, version }) => ({ id, name, url, addedAt, lastSeen: lastSeen || 0, version: version || '' }));
  }

  get(id) {
    const m = this.list.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error('That machine is no longer in your list'), { status: 404 });
    return m;
  }

  async token(m) {
    return unprotect(m.token);
  }

  /** A request to machine `m` as its owner. */
  async call(m, p, { method = 'GET', body, headers = {}, timeout = 20000, raw = false } = {}) {
    const t = await this.token(m);
    const ctl = new AbortController();
    const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
    try {
      const r = await fetch(m.url + p, { method, headers: { authorization: `Bearer ${t}`, 'x-orbix': '1', ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ? body : body ? JSON.stringify(body) : undefined, signal: ctl.signal, ...(raw ? { duplex: 'half' } : {}) });
      const j = await r.json().catch(() => ({ ok: false, error: `${m.name || m.url} answered ${r.status}` }));
      if (!r.ok || j.ok === false) throw Object.assign(new Error(j.error || `${m.name || m.url} answered ${r.status}`), { status: r.status === 401 ? 400 : 502 });
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error(`${m.name || m.url} did not answer in time`), { status: 504 });
      if (e.status) throw e;
      throw Object.assign(new Error(`Could not reach ${m.name || m.url}: ${e.cause?.code || e.message}`), { status: 502 });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check a machine: it is ORBIX, the token works. Returns { version, procs }. */
  async check(m) {
    const ping = await fetch(m.url + '/api/ping', { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch((e) => {
      throw Object.assign(new Error(`Could not reach ${m.url}: ${e.cause?.code || e.message}`), { status: 502 });
    });
    if (ping?.app !== 'orbix') throw Object.assign(new Error(`${m.url} is not an ORBIX server`), { status: 400 });
    const st = await this.call(m, '/api/procs').catch((e) => {
      throw Object.assign(new Error(e.status === 400 ? 'The machine refused the token. Copy it again from <data>/server-token on the machine.' : e.message), { status: 400 });
    });
    return { version: ping.version, procs: (st.procs || []).length };
  }

  async add({ name, url, token }) {
    const u = cleanUrl(url);
    const t = String(token || '').trim();
    if (t.length < 24) throw Object.assign(new Error('Paste the machine’s token (orbix-server prints it; it is in <data>/server-token).'), { status: 400 });
    const draft = { id: uid('m'), name: String(name || '').trim().slice(0, 60) || new URL(u).hostname, url: u, token: await protect(t), addedAt: Date.now() };
    const c = await this.check(draft);
    draft.version = c.version;
    draft.lastSeen = Date.now();
    this.list = [...this.list.filter((x) => x.url !== u), draft];
    this.save();
    return draft;
  }

  remove(id) {
    this.list = this.list.filter((x) => x.id !== id);
    this.save();
  }

  /** The one-time link that opens machine `id` in a window (the token is exchanged for a cookie there). */
  async openUrl(id) {
    const m = this.get(id);
    return `${m.url}/?t=${encodeURIComponent(await this.token(m))}`;
  }

  /**
   * Move conversation `procId` to machine `id`: stop it here, send its project and its saved conversation, open it
   * there. Returns { machine, proc, workspace } of the conversation on the machine.
   */
  async teleport(procId, id) {
    const m = this.get(id);
    const s = this.s;
    const p = s.proc(procId);
    if (p.streaming) throw Object.assign(new Error('The agent is still working. Stop it or wait until it is done, then move the conversation.'), { status: 409 });
    if (!p.session?.file) throw Object.assign(new Error('Send a first message: there is nothing saved to move yet.'), { status: 400 });
    await this.check(m);
    const file = p.session.file;
    const workspace = p.worktree?.path || p.workspace;
    const project = path.basename(String(p.worktree?.source || p.workspace).replace(/[\\/]+$/, '')) || 'project';
    // 1. The project, streamed as it is packed.
    const tar = tarProject(s.backend, workspace);
    let size = 0;
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    const body = Readable.from((async function* () {
      for await (const chunk of tar.stdout) {
        size += chunk.length;
        if (size > MAX_BUNDLE) {
          killTree(tar);
          throw new Error('The project is larger than 1 GB packed. Leave big generated folders out of it, or clone it on the machine.');
        }
        yield chunk;
      }
    })());
    const up = await this.call(m, `/api/teleport/files?name=${encodeURIComponent(project)}`, { method: 'POST', body, raw: true, headers: { 'content-type': 'application/gzip' }, timeout: 0 }).catch((e) => {
      throw Object.assign(new Error(`Sending the project failed: ${e.message}${err ? ` (${err.trim().split('\n')[0]})` : ''}`), { status: e.status || 502 });
    });
    // 2. The conversation, and the agent CLI's own session when it can travel (Claude Code).
    const lines = fs.readFileSync(file, 'utf8');
    const native = await this.nativeFile(p).catch(() => null);
    const opened = await this.call(m, '/api/teleport/open', { method: 'POST', body: { ticket: up.ticket, name: project, lines, from: os.hostname(), native }, timeout: 120000 });
    // 3. Here, the conversation is closed and marked as moved.
    await p.stop(3000).catch(() => {});
    appendEntry(file, { type: 'teleported', to: m.name, url: m.url, at: Date.now() });
    m.lastSeen = Date.now();
    this.save();
    log('teleported', file, '→', m.url, `${Math.round(size / 1024)} KB`);
    return { machine: { id: m.id, name: m.name, url: m.url }, proc: opened.proc, workspace: opened.workspace, bytes: size };
  }

  /** Claude Code keeps its session in ~/.claude/projects/<folder>/<id>.jsonl: that file moves with the conversation. */
  async nativeFile(p) {
    if (p.agent?.kind !== 'claude' || !p.nativeId) return null;
    const home = await p.backend.home();
    const slug = p.backend.execPath(p.workspace).replace(/[^A-Za-z0-9]/g, '-');
    const join = p.backend.isWsl ? path.posix.join : path.join;
    const f = p.backend.hostPath(join(home, '.claude', 'projects', slug, `${p.nativeId}.jsonl`));
    const text = await fs.promises.readFile(f, 'utf8');
    return text.length > 64 * 1024 * 1024 ? null : { kind: 'claude', id: p.nativeId, text };
  }
}

// ---- The receiving machine --------------------------------------------------------------------------------------

const tickets = new Map(); // ticket → { file, at }
const ticketDir = () => path.join(DATA_DIR, 'teleports');

/** Receive a project tarball (raw body). */
export async function receiveFiles(req) {
  fs.mkdirSync(ticketDir(), { recursive: true });
  const ticket = crypto.randomBytes(12).toString('hex');
  const file = path.join(ticketDir(), `${ticket}.tgz`);
  let n = 0;
  const limit = new (await import('node:stream')).Transform({
    transform(chunk, _e, cb) {
      n += chunk.length;
      cb(n > MAX_BUNDLE ? Object.assign(new Error('The project is larger than 1 GB'), { status: 413 }) : null, chunk);
    },
  });
  await pipeline(req, limit, fs.createWriteStream(file, { mode: 0o600 }));
  tickets.set(ticket, { file, at: Date.now() });
  for (const [k, v] of tickets) if (Date.now() - v.at > 3600000) (tickets.delete(k), fs.rmSync(v.file, { force: true }));
  return { ticket, bytes: n };
}

/** Unpack a received project and reopen its conversation here. */
export async function openTeleport(server, { ticket, name, lines, from, native }) {
  const t = tickets.get(String(ticket || ''));
  if (!t) throw Object.assign(new Error('The project did not arrive (or arrived more than an hour ago). Try again.'), { status: 400 });
  tickets.delete(ticket);
  const safe = String(name || 'project').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'project';
  const rootDir = path.join(await server.backend.home(), 'orbix-projects');
  let dest = path.join(rootDir, safe);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(rootDir, `${safe}-${i}`);
  fs.mkdirSync(dest, { recursive: true });
  try {
    const r = await server.backend.exec(['tar', '-xzf', server.backend.execPath(t.file), '-C', server.backend.execPath(dest)], { timeout: 600000 });
    if (r.code !== 0) throw new Error(`Unpacking the project failed: ${String(r.stderr).trim().split('\n')[0]}`);
  } finally {
    fs.rmSync(t.file, { force: true });
  }
  server.store.addWorkspace(dest, safe);
  const file = importSession({ cwd: dest, keyPath: server.backend.keyPath(dest), lines, from });
  const head = loadSession(file);
  // Claude Code resumes from its own session file, placed where it looks for this folder's sessions.
  if (native?.kind === 'claude' && native.id && /^[\w-]+$/.test(native.id) && typeof native.text === 'string') {
    const slug = server.backend.execPath(dest).replace(/[^A-Za-z0-9]/g, '-');
    const dir = server.backend.hostPath(path.posix.join(await server.backend.home(), '.claude', 'projects', slug));
    fs.mkdirSync(dir, { recursive: true });
    const oldCwd = JSON.parse(String(lines).split('\n')[0] || '{}').cwd || '';
    fs.writeFileSync(path.join(dir, `${native.id}.jsonl`), oldCwd ? native.text.split(JSON.stringify(oldCwd).slice(1, -1)).join(JSON.stringify(dest).slice(1, -1)) : native.text);
  } else if (head.native && head.header?.engine?.startsWith('agent-')) {
    // The agent's own session stayed behind: it starts a new one, told what happened so far.
    appendEntry(file, { type: 'native', id: '' });
    appendEntry(file, { type: 'handoff', at: Date.now() });
  }
  const proc = await server.startProc({ workspace: dest, resume: file });
  server.broadcast({ g: 'engine', engine: server.engineView() });
  return { proc: proc.id, workspace: dest, file, version: VERSION };
}
