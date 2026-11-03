// MCP (Model Context Protocol) client for the ORBIX agent. JSON-RPC 2.0 over stdio (newline-delimited) or
// streamable HTTP. Servers come from DATA_DIR/mcp.json (user) and <project>/.mcp.json (project), both in the
// common format {"mcpServers": {name: {command, args, env} | {url, headers}}}. Servers start lazily on the first
// prompt, run through the session's backend (WSL or Windows) and stop with the session. Their tools are exposed
// as mcp__<server>__<tool>. Project servers only start after the user trusts that exact config once.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../store.mjs';
import { VERSION, readJson, writeJson, log } from '../util.mjs';
import { parseSSE } from './anthropic.mjs';
import { killTree } from '../backend.mjs';
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from './files.mjs';

const userConfigPath = () => path.join(DATA_DIR, 'mcp.json');
const trustPath = () => path.join(DATA_DIR, 'mcp-trust.json');
const projectConfigPath = (hostRoot) => path.join(hostRoot, '.mcp.json');

const PROTOCOL = '2025-06-18';
const INIT_TIMEOUT = 60000;
const CALL_TIMEOUT = 180000;
const MAX_RESULT = 60000;

// ---------- config ----------
function readConfig(file) {
  const j = readJson(file, null);
  const servers = j && typeof j.mcpServers === 'object' && j.mcpServers ? j.mcpServers : {};
  return { exists: !!j, servers };
}

/** Throws a readable error when a server entry is not usable. Returns a cleaned copy. */
function validateServer(name, cfg) {
  if (!/^[A-Za-z0-9][\w.-]{0,47}$/.test(String(name || ''))) throw new Error('Server name: letters, digits, "-", "_" or "." (max 48)');
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('The server config must be a JSON object');
  const out = {};
  if (cfg.url != null) {
    if (typeof cfg.url !== 'string' || !/^https?:\/\//i.test(cfg.url)) throw new Error('"url" must start with http:// or https://');
    out.url = cfg.url;
    if (cfg.headers != null) {
      if (typeof cfg.headers !== 'object' || Object.values(cfg.headers).some((v) => typeof v !== 'string')) throw new Error('"headers" must map names to strings');
      out.headers = cfg.headers;
    }
  } else {
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) throw new Error('Give either "command" (a program to run) or "url"');
    out.command = cfg.command.trim();
    if (cfg.args != null) {
      if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== 'string')) throw new Error('"args" must be a list of strings');
      out.args = cfg.args;
    }
    if (cfg.env != null) {
      if (typeof cfg.env !== 'object' || Object.entries(cfg.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) throw new Error('"env" must map variable names to strings');
      out.env = cfg.env;
    }
    if (cfg.cwd != null) out.cwd = String(cfg.cwd);
  }
  if (cfg.disabled != null) out.disabled = !!cfg.disabled;
  if (cfg.timeout != null) {
    const t = Number(cfg.timeout);
    if (!(t > 0)) throw new Error('"timeout" must be a positive number of seconds');
    out.timeout = t;
  }
  return out;
}

function saveUserServer(name, cfg, oldName) {
  const clean = validateServer(name, cfg);
  const file = userConfigPath();
  const j = readJson(file, {}) || {};
  j.mcpServers = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
  if (oldName && oldName !== name) delete j.mcpServers[oldName];
  j.mcpServers[name] = clean;
  writeJson(file, j);
  return clean;
}

function removeUserServer(name) {
  const file = userConfigPath();
  const j = readJson(file, {}) || {};
  if (j.mcpServers) delete j.mcpServers[name];
  writeJson(file, { ...j, mcpServers: j.mcpServers || {} });
}

const trustKey = (scopeRoot, name, cfg) => crypto.createHash('sha256').update(JSON.stringify([scopeRoot, name, cfg])).digest('hex').slice(0, 32);
const isTrusted = (k) => (readJson(trustPath(), {})?.trusted || []).includes(k);
function addTrust(k) {
  const j = readJson(trustPath(), {}) || {};
  j.trusted = [...new Set([...(j.trusted || []), k])].slice(-500);
  writeJson(trustPath(), j);
}

/**
 * What a project server would run, for the trust question. Nothing is hidden: a long command keeps its start and its
 * end (padding cannot push the dangerous part out of view).
 */
export function describeServer(cfg) {
  let what = cfg.url ? `${cfg.url}${cfg.headers ? ` (headers: ${Object.keys(cfg.headers).join(', ')})` : ''}` : [cfg.command, ...(cfg.args || [])].map((a) => (/[\s"]/.test(a) || !a ? JSON.stringify(a) : a)).join(' ');
  // Values of secret-looking variables are masked; others (NODE_OPTIONS, PATH...) can change what runs, so they show.
  if (cfg.env) what += ` (environment: ${Object.entries(cfg.env).map(([k, v]) => (/token|secret|key|pass|auth|cred/i.test(k) ? `${k}=<${v.length} characters>` : `${k}=${v}`)).join(' ')})`;
  if (cfg.cwd) what += ` (in ${cfg.cwd})`;
  what = what.replace(/\s+/g, ' ');
  return what.length > 900 ? `${what.slice(0, 600)} … [${what.length - 900} characters not shown] … ${what.slice(-300)}` : what;
}

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

/** On native Windows, find `npx` -> C:\...\npx.cmd using PATH and PATHEXT, so spawn() can run it. */
function resolveWinCommand(cmd) {
  if (process.platform !== 'win32' || /[\\/]/.test(cmd) || path.extname(cmd)) return cmd;
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(dir, cmd + ext.toLowerCase());
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return cmd;
}

// ---------- transports ----------
class StdioTransport {
  constructor({ backend, cwd, cfg, onMessage, onClose }) {
    this.onMessage = onMessage;
    this.stderr = [];
    let argv;
    if (backend.isWsl) {
      // A login shell gives the user's PATH (nvm, ~/.local/bin…); `exec "$@"` keeps the arguments intact.
      const env = Object.entries(cfg.env || {}).map(([k, v]) => `${k}=${v}`);
      argv = ['bash', '-lc', 'exec "$@"', 'mcp', ...(env.length ? ['env', ...env] : []), cfg.command, ...(cfg.args || [])];
    } else argv = [resolveWinCommand(cfg.command), ...(cfg.args || [])];
    // quiet: server arguments often carry tokens, which must not reach the log.
    this.child = backend.spawn(argv, { cwd: cfg.cwd || cwd, env: backend.isWsl ? undefined : cfg.env, quiet: true });
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // servers sometimes print logs to stdout; ignore non-JSON lines
        }
        for (const m of Array.isArray(msg) ? msg : [msg]) this.onMessage(m);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      for (const l of d.split(/\r?\n/)) if (l.trim()) this.stderr.push(l.slice(0, 400));
      if (this.stderr.length > 40) this.stderr.splice(0, this.stderr.length - 40);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (e) => onClose(e));
    this.child.on('close', (code) => onClose(new Error(`exited with code ${code}`)));
  }
  send(msg) {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(msg) + '\n');
  }
  async close() {
    try {
      this.child.stdin.end();
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(r, 1500);
      this.child.once('close', () => {
        clearTimeout(t);
        r();
      });
    });
    killTree(this.child); // npx.cmd & co. run the real server as a grandchild
  }
}

class HttpTransport {
  constructor({ cfg, onMessage, onClose }) {
    this.url = cfg.url;
    this.headers = cfg.headers || {};
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.sessionId = null;
    this.stderr = [];
    this.ctl = new AbortController();
  }
  send(msg) {
    this._post(msg).catch((e) => {
      if (msg.id != null) this.onMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } });
    });
  }
  async _post(msg) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...this.headers };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(msg), signal: this.ctl.signal });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}${t ? ': ' + t.slice(0, 200) : ''}`);
    }
    const ct = r.headers.get('content-type') || '';
    if (r.status === 202 || msg.id == null) return void r.body?.cancel?.().catch?.(() => {});
    if (ct.includes('text/event-stream')) {
      for await (const { data } of parseSSE(r.body, this.ctl.signal)) {
        let m;
        try {
          m = JSON.parse(data);
        } catch {
          continue;
        }
        for (const x of Array.isArray(m) ? m : [m]) {
          this.onMessage(x);
          if (x.id === msg.id && (x.result !== undefined || x.error)) return;
        }
      }
      return;
    }
    const j = await r.json();
    for (const x of Array.isArray(j) ? j : [j]) this.onMessage(x);
  }
  async close() {
    if (this.sessionId) {
      await fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.sessionId, ...this.headers }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
    this.ctl.abort();
  }
}

// ---------- one server ----------
class McpClient {
  constructor({ name, cfg, scope, backend, cwd }) {
    this.name = name;
    this.cfg = cfg;
    this.scope = scope;
    this.backend = backend;
    this.cwd = cwd;
    this.status = 'stopped';
    this.error = null;
    this.tools = [];
    this.serverInfo = null;
    this.instructions = '';
    this.pending = new Map();
    this.seq = 0;
    this.transport = null;
    this.starting = null;
    this.toolsChanged = false;
  }

  start() {
    if (this.status === 'running') return Promise.resolve(this);
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => (this.starting = null));
    return this.starting;
  }

  async _start() {
    this.status = 'starting';
    this.error = null;
    const onMessage = (m) => this._onMessage(m);
    const onClose = (e) => {
      if (this.status === 'stopped') return;
      const tail = this.transport?.stderr?.slice(-3).join(' | ');
      this.status = 'error';
      this.error = `${e?.message || 'closed'}${tail ? ' — ' + tail : ''}`;
      for (const [, p] of this.pending) p.reject(new Error(`MCP server "${this.name}" ${this.error}`));
      this.pending.clear();
    };
    try {
      this.transport = this.cfg.url ? new HttpTransport({ cfg: this.cfg, onMessage, onClose }) : new StdioTransport({ backend: this.backend, cwd: this.cwd, cfg: this.cfg, onMessage, onClose });
      const init = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: false } }, clientInfo: { name: 'orbix', version: VERSION } }, { timeout: INIT_TIMEOUT });
      this.serverInfo = init?.serverInfo || null;
      this.instructions = typeof init?.instructions === 'string' ? init.instructions.slice(0, 2000) : '';
      this.notify('notifications/initialized');
      await this.listTools();
      this.status = 'running';
      return this;
    } catch (e) {
      const tail = this.transport?.stderr?.slice(-3).join(' | ');
      this.status = 'error';
      this.error = `${e.message}${tail && !String(e.message).includes(tail) ? ' — ' + tail : ''}`;
      await this.transport?.close().catch(() => {});
      throw new Error(`MCP server "${this.name}" could not start: ${this.error}`);
    }
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, { timeout: INIT_TIMEOUT });
      tools.push(...(r?.tools || []));
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    this.tools = tools.filter((t) => t && typeof t.name === 'string');
    this.toolsChanged = false;
    return this.tools;
  }

  _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.id != null && m.method) {
      // A request from the server.
      const reply = (result, error) => this.transport.send({ jsonrpc: '2.0', id: m.id, ...(error ? { error } : { result }) });
      if (m.method === 'ping') return reply({});
      if (m.method === 'roots/list') {
        const p = String(this.backend.execPath(this.cwd)).replace(/\\/g, '/');
        return reply({ roots: [{ uri: 'file://' + (p.startsWith('/') ? '' : '/') + encodeURI(p), name: 'project' }] });
      }
      return reply(null, { code: -32601, message: `Method not supported: ${m.method}` });
    }
    if (m.id != null && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'MCP error'), { code: m.error.code }));
      else p.resolve(m.result);
      return;
    }
    if (m.method === 'notifications/tools/list_changed') this.toolsChanged = true;
  }

  request(method, params, { timeout = CALL_TIMEOUT, signal } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new Error(`${method} timed out after ${Math.round(timeout / 1000)}s`));
      }, timeout);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'stopped by the user' });
        reject(Object.assign(new Error('Stopped'), { aborted: true }));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = (fn) => (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        fn(v);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    try {
      this.transport?.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    } catch {}
  }

  async callTool(name, args, signal) {
    if (this.status !== 'running') await this.start();
    if (this.toolsChanged) await this.listTools().catch(() => {});
    const r = await this.request('tools/call', { name, arguments: args || {} }, { timeout: (this.cfg.timeout || CALL_TIMEOUT / 1000) * 1000, signal });
    return formatResult(r);
  }

  async stop() {
    const was = this.status;
    this.status = 'stopped';
    for (const [, p] of this.pending) p.reject(new Error('stopped'));
    this.pending.clear();
    if (was !== 'stopped') await this.transport?.close().catch(() => {});
  }
}

function formatResult(r) {
  const parts = [];
  const images = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image' && typeof c.data === 'string' && IMAGE_TYPES.has(String(c.mimeType).toLowerCase()) && (c.data.length * 3) / 4 <= MAX_IMAGE_BYTES && images.length < 8) images.push({ type: 'image', data: c.data, mimeType: String(c.mimeType).toLowerCase() });
    else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type}: ${c.mimeType || 'binary'}, ${Math.round(((c.data || '').length * 3) / 4)} bytes, not shown]`);
    else if (c.type === 'resource') parts.push(c.resource?.text != null ? `[resource ${c.resource.uri || ''}]\n${c.resource.text}` : `[resource ${c.resource?.uri || ''} (${c.resource?.mimeType || 'binary'})]`);
    else if (c.type === 'resource_link') parts.push(`[link ${c.name || ''}: ${c.uri || ''}]`);
  }
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  let text = parts.join('\n') || (images.length ? `(${images.length} image${images.length === 1 ? '' : 's'})` : '(the tool returned no content)');
  if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + `\n[output truncated: ${text.length - MAX_RESULT} more characters]`;
  return { text, ...(images.length ? { images } : {}), isError: !!r?.isError };
}

// ---------- per-session manager ----------
const liveManagers = new Set();

export class McpManager {
  /** ask(title, options) -> Promise<string|null>; notice(level, message). */
  constructor({ backend, workspace, hostRoot, ask, notice }) {
    this.backend = backend;
    this.workspace = workspace;
    this.hostRoot = hostRoot;
    this.ask = ask;
    this.notice = notice;
    this.clients = new Map(); // key scope:name -> McpClient
    this.byTool = new Map(); // exposed name -> { client, tool }
    this.denied = new Set();
    this.closed = false;
    liveManagers.add(this);
  }

  configs() {
    const user = readConfig(userConfigPath()).servers;
    const proj = readConfig(projectConfigPath(this.hostRoot)).servers;
    const out = [];
    for (const [name, cfg] of Object.entries(user)) out.push({ name, cfg, scope: 'user' });
    for (const [name, cfg] of Object.entries(proj)) if (!user[name]) out.push({ name, cfg, scope: 'project' });
    return out;
  }

  /** Start every enabled server that is not running yet (in parallel). Never throws: failures become notices. */
  async ensureStarted() {
    if (this.closed) return;
    const wanted = new Map();
    for (const { name, cfg, scope } of this.configs()) {
      let clean;
      try {
        clean = validateServer(name, cfg);
      } catch (e) {
        this._warnOnce(`${scope}:${name}:invalid`, `MCP server "${name}" is not set up correctly: ${e.message}`);
        continue;
      }
      if (clean.disabled) continue;
      wanted.set(`${scope}:${name}`, { name, cfg: clean, scope });
    }
    // Stop servers that were removed or whose config changed.
    for (const [key, c] of this.clients) {
      const w = wanted.get(key);
      if (!w || JSON.stringify(w.cfg) !== JSON.stringify(c.cfg)) {
        await c.stop();
        this.clients.delete(key);
      }
    }
    const starts = [];
    for (const [key, w] of wanted) {
      if (this.denied.has(key)) continue;
      let c = this.clients.get(key);
      if (c && (c.status === 'running' || c.status === 'starting')) continue;
      if (c?.status === 'error' && c.failedAt && Date.now() - c.failedAt < 60000) continue;
      if (w.scope === 'project') {
        const k = trustKey(this.backend.keyPath(this.workspace), w.name, w.cfg);
        if (!isTrusted(k)) {
          const ans = await this.ask(`This project's .mcp.json wants to start the MCP server "${w.name}": ${describeServer(w.cfg)}`, ['Allow and remember', 'Allow once', 'Do not start']);
          if (this.closed) return;
          if (ans === 'Allow and remember') addTrust(k);
          else if (ans !== 'Allow once') {
            this.denied.add(key);
            continue;
          }
        }
      }
      if (this.closed) return; // the session stopped while we waited
      if (!c) {
        c = new McpClient({ name: w.name, cfg: w.cfg, scope: w.scope, backend: this.backend, cwd: this.workspace });
        this.clients.set(key, c);
      }
      starts.push(
        c.start().catch((e) => {
          c.failedAt = Date.now();
          this._warnOnce(`${key}:${e.message}`, e.message);
          log('mcp', e.message);
        }),
      );
    }
    await Promise.all(starts);
    this._index();
  }

  _warnOnce(key, msg) {
    (this._warned ||= new Set());
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.notice('warn', msg);
  }

  _index() {
    this.byTool.clear();
    for (const c of this.clients.values()) {
      if (c.status !== 'running') continue;
      for (const t of c.tools) {
        let n = `mcp__${sanitize(c.name)}__${sanitize(t.name)}`;
        if (n.length > 64) n = n.slice(0, 55) + '_' + crypto.createHash('sha1').update(n).digest('hex').slice(0, 8);
        if (!this.byTool.has(n)) this.byTool.set(n, { client: c, tool: t });
      }
    }
  }

  toolDefs() {
    return [...this.byTool].map(([name, { client, tool }]) => {
      const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? { ...tool.inputSchema } : {};
      if (schema.type !== 'object') schema.type = 'object';
      if (!schema.properties) schema.properties = {};
      delete schema.$schema;
      return { name, description: `[MCP ${client.name}] ${String(tool.description || tool.title || tool.name).slice(0, 1000)}`, input_schema: schema };
    });
  }

  has(name) {
    return this.byTool.has(name);
  }

  isReadOnly(name) {
    return this.byTool.get(name)?.tool?.annotations?.readOnlyHint === true;
  }

  describe(name) {
    const e = this.byTool.get(name);
    return e ? `${e.client.name} → ${e.tool.name}` : name;
  }

  async call(name, args, signal) {
    const e = this.byTool.get(name);
    if (!e) return { text: `MCP tool ${name} is not available (its server may have stopped).`, isError: true };
    try {
      const r = await e.client.callTool(e.tool.name, args, signal);
      return { ...r, details: { server: e.client.name, tool: e.tool.name } };
    } catch (err) {
      return { text: err.aborted ? 'Stopped.' : `MCP error from ${e.client.name}: ${err.message}`, isError: true, details: { server: e.client.name, tool: e.tool.name } };
    }
  }

  instructionsText() {
    const parts = [];
    for (const c of this.clients.values()) if (c.status === 'running' && c.instructions) parts.push(`- ${c.name}: ${c.instructions.replace(/\s+/g, ' ').slice(0, 600)}`);
    return parts.length ? `# MCP servers\nConnected servers (their tools are named mcp__<server>__<tool>):\n${parts.join('\n')}` : '';
  }

  status() {
    return [...this.clients.values()].map((c) => ({ name: c.name, scope: c.scope, status: c.status, error: c.error, tools: c.tools.map((t) => t.name) }));
  }

  async stopAll() {
    this.closed = true;
    liveManagers.delete(this);
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
    this.byTool.clear();
  }
}

/** Start a server just long enough to list its tools (Settings → Test). */
async function testServer({ name, cfg, backend, cwd }) {
  const clean = validateServer(name || 'test', cfg);
  const c = new McpClient({ name: name || 'test', cfg: clean, scope: 'test', backend, cwd });
  const t0 = Date.now();
  try {
    await c.start();
    return { serverInfo: c.serverInfo, ms: Date.now() - t0, tools: c.tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 200), readOnly: t.annotations?.readOnlyHint === true })) };
  } finally {
    await c.stop();
  }
}

// ---------- HTTP routes (mounted by server.mjs) ----------
export function mcpRoutes(server) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const live = (scope, name, wsKey) => {
    for (const m of liveManagers) {
      if (scope === 'project' && m.backend.keyPath(m.workspace) !== wsKey) continue;
      const c = m.clients.get(`${scope}:${name}`);
      if (c) return { status: c.status, error: c.error, tools: c.tools.map((t) => t.name) };
    }
    return { status: 'not started', error: null, tools: null };
  };
  const view = (servers, scope, wsKey) => Object.entries(servers).map(([name, cfg]) => ({ name, scope, config: cfg, ...live(scope, name, wsKey) }));
  return {
    'GET /api/mcp': async ({ q }) => {
      const user = readConfig(userConfigPath());
      let project = null;
      if (q.ws) {
        const hostRoot = server.backend.hostPath(q.ws);
        const pc = readConfig(projectConfigPath(hostRoot));
        project = { file: projectConfigPath(hostRoot), exists: pc.exists, servers: view(pc.servers, 'project', server.backend.keyPath(q.ws)) };
      }
      return { file: userConfigPath(), servers: view(user.servers, 'user'), project };
    },
    'POST /api/mcp/save': async ({ body }) => {
      try {
        saveUserServer(String(body.name || '').trim(), body.config, body.oldName ? String(body.oldName) : null);
      } catch (e) {
        throw bad(e.message);
      }
      return {};
    },
    'POST /api/mcp/remove': async ({ body }) => {
      removeUserServer(String(body.name || ''));
      return {};
    },
    'POST /api/mcp/test': async ({ body }) => {
      server.backend.update(server.store.data.backend);
      const cwd = body.ws || server.store.data.workspaces?.[0]?.path || (server.backend.isWsl ? '/' : process.cwd());
      try {
        return { result: await testServer({ name: String(body.name || 'test'), cfg: body.config, backend: server.backend, cwd }) };
      } catch (e) {
        throw bad(e.message);
      }
    },
  };
}
