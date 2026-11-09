// ORBIX local server: static UI, JSON API and one SSE event stream. Binds to 127.0.0.1 only; everything except
// /api/ping and the OpenRouter sign-in callback needs the per-launch token cookie.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, VERSION, log, uid, safeLink } from './util.mjs';
import { Backend } from './backend.mjs';
import { AgentProc } from './engine/proc.mjs';
import { mcpRoutes } from './engine/mcp.mjs';
import { EngineConfig, listAgentSessions, deleteAgentSessions, isAgentSessionPath } from './engine/store.mjs';
import { clientFor } from './engine/providers.mjs';
import * as oauth from './engine/oauth.mjs';
import * as oauthXai from './engine/oauth-xai.mjs';
import { webSearch } from './engine/websearch.mjs';
import { readHooksFile, listHooks, userHooksPath, projectHooksPath, hooksTrusted } from './engine/hooks.mjs';
import { collect as collectDiagnostics } from './diagnostics.mjs';
import * as fsapi from './fsapi.mjs';
import * as gitapi from './gitapi.mjs';
import { openExternal } from './launcher.mjs';

export { VERSION };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** extension_ui_request methods that wait for an answer (the rest are notifications). */
const ASK_METHODS = new Set(['select']);

/** Keep `open` (id -> request) in step with a session's events: questions it asks, cancels, and a finished turn. */
export function trackOpenUi(open, ev) {
  if (ev.type === 'extension_ui_request') {
    if (ASK_METHODS.has(ev.method) && ev.id != null) open.set(ev.id, ev);
    else if (ev.method === 'cancel') open.delete(ev.targetId);
  } else if (ev.type === 'agent_end' && ev.isTerminal !== false) open.clear();
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** On every response: no sniffing, no framing, no referrer, and no use of our responses by other origins. */
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

/** Strip bulky, UI-irrelevant fields from a model descriptor. */
function slimModel(m) {
  if (!m) return m;
  return {
    id: m.id,
    provider: m.provider,
    name: m.name,
    reasoning: !!m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    thinking: m.thinking ? { efforts: m.thinking.efforts, mode: m.thinking.mode } : undefined,
  };
}

function shapeResponse(type, res) {
  if (!res.data) return res;
  if (type === 'get_state') return { ...res, data: { ...res.data, model: slimModel(res.data.model) } };
  if (type === 'get_available_models') return { ...res, data: { ...res.data, models: (res.data.models || []).map(slimModel) } };
  return res;
}

export class AppServer {
  constructor({ store, token, webRoot = path.join(ROOT, 'web'), assetsRoot = path.join(ROOT, 'assets') }) {
    this.store = store;
    this.token = token;
    this.webRoot = webRoot;
    this.assetsRoot = assetsRoot;
    this.backend = new Backend(store.data.backend);
    this.engineCfg = new EngineConfig();
    this.procs = new Map();
    this.clients = new Set();
    this.envInfo = {};
    this.envReady = Promise.resolve();
    this.hadClient = false;
    this.lastClientAt = Date.now();
    this.pendingUpdates = new Map();
    this.onQuit = null;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    this.server.keepAliveTimeout = 5000;
    this.routes = this.buildRoutes();
    setInterval(() => this.heartbeat(), 15000).unref();
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const onErr = (e) => reject(e);
      this.server.once('error', onErr);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', onErr);
        this.port = this.server.address().port;
        this.hosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
        resolve(this.port);
      });
    });
  }

  /** First-run backend choice, then a check that it is reachable. Runs after listen(); /api/state waits for it. */
  startEnv() {
    this.envReady = this.store
      .autodetect(this.backend)
      .catch((e) => log('autodetect failed', e))
      .then(() => this.refreshEnv());
    return this.envReady;
  }

  async refreshEnv() {
    try {
      this.backend.update(this.store.data.backend);
      const p = await this.backend.probe();
      const unreachable = this.backend.isWsl && !p.home;
      this.envInfo = unreachable ? { error: `Can’t reach the WSL distribution "${this.backend.distro}". Make sure it’s installed and can start.` } : {};
    } catch (e) {
      this.envInfo = { error: e.message };
    }
  }

  get busy() {
    return [...this.procs.values()].some((p) => p.streaming);
  }

  /** An agent is blocked on a question (approval) for the user. */
  get waitingForUser() {
    return [...this.procs.values()].some((p) => p.pendingAsk?.size > 0 || p.openUi?.size > 0);
  }

  async shutdown() {
    log('shutdown');
    await Promise.all([...this.procs.values()].map((p) => p.stop(2500).catch(() => {})));
    for (const c of this.clients) {
      try {
        c.end();
      } catch {}
    }
    this.server.close();
  }

  broadcast(msg) {
    if (!this.clients.size) return;
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const c of this.clients) {
      if (c.writableLength > 16 * 1024 * 1024) {
        this.clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(data);
    }
  }
  heartbeat() {
    for (const c of this.clients) c.write(': ping\n\n');
  }
  procList() {
    return [...this.procs.values()].map((p) => ({ id: p.id, workspace: p.workspace, streaming: p.streaming, startedAt: p.startedAt, resume: p.opts.resume || null, file: p.session?.file || null, engine: 'builtin' }));
  }
  broadcastProcs() {
    this.broadcast({ g: 'procs', procs: this.procList() });
  }

  flushUpdates(id) {
    const m = this.pendingUpdates.get(id);
    if (!m) return;
    clearTimeout(m.timer);
    this.pendingUpdates.delete(id);
    for (const ev of m.events.values()) this.broadcast({ p: id, e: ev });
  }

  forward(id, ev) {
    // Coalesce high-frequency snapshot events: each carries the full state, so only the latest matters.
    if (ev.type === 'message_update' || ev.type === 'tool_execution_update' || ev.type === 'tool_stream_update') {
      let m = this.pendingUpdates.get(id);
      if (!m) {
        m = { events: new Map(), timer: setTimeout(() => this.flushUpdates(id), 40) };
        this.pendingUpdates.set(id, m);
      }
      const key = ev.type + ':' + (ev.toolCallId || ev.assistantMessageEvent?.contentIndex || '');
      const slim = ev.type === 'message_update' && ev.assistantMessageEvent?.partial ? { ...ev, assistantMessageEvent: stripPartial(ev.assistantMessageEvent) } : ev;
      // A *_start/_end event must never be dropped by a later delta: deliver them immediately.
      const t = ev.assistantMessageEvent?.type || '';
      if (ev.type === 'message_update' && !/_delta$/.test(t)) {
        this.flushUpdates(id);
        this.broadcast({ p: id, e: slim });
        return;
      }
      m.events.set(key, slim);
      return;
    }
    this.flushUpdates(id);
    let out = ev;
    if (ev.type === 'agent_end') {
      const { messages, ...rest } = ev;
      out = { ...rest, messageCount: Array.isArray(messages) ? messages.length : 0 };
    }
    this.broadcast({ p: id, e: out });
  }

  async startProc({ workspace, resume, model, noSession }) {
    if (!workspace) throw new Error('A workspace folder is required');
    // Two agents appending to one saved conversation would interleave it.
    if (resume && [...this.procs.values()].some((p) => p.opts.resume === resume || p.session?.file === resume)) {
      throw Object.assign(new Error('That conversation is already open in another tab.'), { status: 409 });
    }
    this.backend.update(this.store.data.backend);
    const id = uid('p');
    const proc = new AgentProc({ id, backend: this.backend, workspace, resume, model, noSession, config: this.engineCfg });
    proc.cache = { commands: [] };
    // Questions waiting for the user (approvals, inputs): a window that reloads or reconnects gets them again.
    proc.openUi = new Map();
    proc.on('event', (ev) => {
      if (ev.type === 'available_commands_update') proc.cache.commands = ev.commands || [];
      trackOpenUi(proc.openUi, ev);
      this.forward(id, ev);
      if (ev.type === 'agent_start' || ev.type === 'agent_end' || ev.type === 'prompt_result') this.broadcastProcs();
    });
    proc.on('stderr', (line) => this.broadcast({ p: id, e: { type: 'stderr', line } }));
    proc.on('exit', (code, msg) => {
      this.flushUpdates(id);
      this.broadcast({ p: id, e: { type: 'proc_exit', code, message: msg || '', stderr: proc.stderrTail.slice(-15) } });
      this.procs.delete(id);
      this.broadcastProcs();
    });
    try {
      await proc.start();
    } catch (e) {
      try {
        await proc.stop(500);
      } catch {}
      throw e;
    }
    this.procs.set(id, proc);
    this.broadcastProcs();
    return proc;
  }

  proc(id) {
    const p = this.procs.get(id);
    if (!p) throw Object.assign(new Error('This session is no longer running'), { status: 410 });
    return p;
  }

  tokenOk(t) {
    const a = Buffer.from(String(t || ''));
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  authed(req) {
    const m = /(?:^|;\s*)orbix=([^;]+)/.exec(req.headers.cookie || '');
    return !!m && this.tokenOk(m[1]);
  }

  json(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body), ...SECURITY_HEADERS });
    res.end(body);
  }

  fail(res, e) {
    log('handler error', e);
    if (res.headersSent) return res.end();
    this.json(res, e.status || 500, { ok: false, error: e.message || String(e) });
  }

  readBody(req, limit = 48 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (d) => {
        n += d.length;
        if (n > limit) {
          reject(Object.assign(new Error('Request too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(d);
      });
      req.on('end', () => {
        if (!n) return resolve({});
        let parsed;
        try {
          // "__proto__" keys are dropped: Object.assign() of such a body (prefs) would swap an object's prototype.
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'), (k, v) => (k === '__proto__' ? undefined : v));
        } catch {
          return reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(Object.assign(new Error('Expected a JSON object'), { status: 400 }));
        resolve(parsed);
      });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // DNS-rebinding guard.
    if (!this.hosts.has((req.headers.host || '').toLowerCase())) return this.json(res, 403, { ok: false, error: 'Bad host' });
    if (url.pathname === '/api/ping') return this.json(res, 200, { app: 'orbix', version: VERSION });

    if (url.pathname === '/' && url.searchParams.get('t')) {
      if (!this.tokenOk(url.searchParams.get('t'))) return this.json(res, 403, { ok: false, error: 'Bad token' });
      res.writeHead(302, { location: '/', 'set-cookie': `orbix=${this.token}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return res.end();
    }
    // OpenRouter sign-in comes back from the user's browser, which has no token cookie; it is checked by a one-time state instead.
    if (req.method === 'GET' && url.pathname.startsWith(oauth.CALLBACK_PATH + '/')) return oauth.handleCallback(url, res, this.engineCfg);
    // A page on another port of this host is "same-site" and gets our cookie on plain GETs (<img>, <script>, links)
    // that carry no Origin. Browsers say where a request comes from: only our own pages (or a typed URL) get through.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return this.json(res, 403, { ok: false, error: 'Cross-site request blocked' });
    if (!this.authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return res.end('ORBIX: open it from the app window or shortcut (token required).');
    }
    if (url.pathname.startsWith('/api/')) {
      // SameSite does not separate ports: a page on another local port would send our cookie. Browsers add Origin to
      // its cross-origin reads, and to every write.
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${req.headers.host}`) || (req.method !== 'GET' && req.headers['x-orbix'] !== '1')) return this.json(res, 403, { ok: false, error: 'Cross-site request blocked' });
      const route = this.routes[`${req.method} ${url.pathname}`];
      if (!route) return this.json(res, 404, { ok: false, error: 'No such endpoint' });
      if (url.pathname !== '/api/events') await this.envReady; // the backend is settled before anything uses it
      const body = req.method === 'GET' ? {} : await this.readBody(req);
      const out = await route({ req, res, url, body, q: Object.fromEntries(url.searchParams) });
      if (out === undefined) return; // handler took over the response (SSE)
      return this.json(res, 200, { ok: true, ...out });
    }
    return this.serveStatic(url.pathname, res, req);
  }

  serveStatic(pathname, res, req) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return this.json(res, 400, { ok: false, error: 'Bad path' });
    }
    if (rel.includes('\0')) return this.json(res, 400, { ok: false, error: 'Bad path' });
    if (rel === '/') rel = '/index.html';
    const base = path.resolve(rel.startsWith('/assets/') ? this.assetsRoot : this.webRoot);
    const sub = rel.startsWith('/assets/') ? rel.slice('/assets/'.length) : rel.slice(1);
    const file = path.resolve(base, sub);
    if (!file.startsWith(base + path.sep) && file !== base) return this.json(res, 403, { ok: false, error: 'Forbidden' });
    fs.stat(file, (e1, st) => {
      if (e1 || !st.isFile()) return this.json(res, 404, { ok: false, error: 'Not found' });
      // Revalidate with an ETag: instant 304s on every launch after the first, but edits show up immediately.
      const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
        etag,
        ...SECURITY_HEADERS,
        'content-security-policy': CSP,
      };
      if (req?.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      fs.readFile(file, (err, buf) => {
        if (err) return this.json(res, 404, { ok: false, error: 'Not found' });
        res.writeHead(200, { ...headers, 'content-length': buf.length });
        res.end(buf);
      });
    });
  }

  stateSnapshot() {
    const d = this.store.data;
    return {
      app: { version: VERSION, pid: process.pid },
      backend: { kind: d.backend.kind, distro: d.backend.distro, error: this.envInfo.error || null },
      workspaces: d.workspaces,
      ui: d.ui,
      procs: this.procList(),
    };
  }

  buildRoutes() {
    const wsPath = (q) => {
      const p = q.ws || q.root;
      if (!p) throw Object.assign(new Error('Missing workspace'), { status: 400 });
      return p;
    };
    return {
      ...mcpRoutes(this),
      'GET /api/state': async () => this.stateSnapshot(),

      'GET /api/env': async () => ({ ...(await Backend.wslInfo()), ...this.stateSnapshot().backend }),

      'POST /api/backend': async ({ body }) => {
        const kind = body.kind === 'native' ? 'native' : 'wsl';
        this.store.data.backend = { kind, distro: String(body.distro || '') };
        this.store.data.backendChosen = true;
        this.store.save();
        this.backend.forget(); // "Check again" (a distro just installed or started) must not reuse the old answer
        await this.refreshEnv();
        return this.stateSnapshot();
      },

      'POST /api/prefs': async ({ body }) => {
        if (body.ui && typeof body.ui === 'object') Object.assign(this.store.data.ui, body.ui);
        this.store.saveSoon();
        return { ui: this.store.data.ui };
      },

      'POST /api/workspaces': async ({ body }) => {
        const p = String(body.path || '').trim();
        if (!p) throw Object.assign(new Error('Path required'), { status: 400 });
        const st = await fs.promises.stat(this.backend.hostPath(fsapi.normalizeForUi(p, this.backend))).catch(() => null);
        if (!st?.isDirectory()) throw Object.assign(new Error(`Not a folder: ${p}`), { status: 400 });
        const w = this.store.addWorkspace(fsapi.normalizeForUi(p, this.backend), body.name);
        return { workspace: w, workspaces: this.store.data.workspaces };
      },
      'POST /api/workspaces/remove': async ({ body }) => {
        this.store.removeWorkspace(body.id);
        return { workspaces: this.store.data.workspaces };
      },

      'GET /api/sessions': async () => {
        const own = await listAgentSessions(this.backend).catch(() => []);
        return { sessions: own.sort((a, b) => b.mtime - a.mtime) };
      },
      'GET /api/engine': async () => ({ engine: this.engineCfg.publicView() }),
      'POST /api/engine/provider': async ({ body }) => {
        const id = String(body.id || '');
        const p = this.engineCfg.provider(id);
        if (!p) throw Object.assign(new Error('Unknown provider'), { status: 400 });
        const typedKey = body.key ? String(body.key).trim() : '';
        const key = typedKey || (await this.engineCfg.getKey(id));
        const baseUrl = p.editableUrl ? String(body.baseUrl || '').trim() : this.engineCfg.baseUrl(id);
        if (!baseUrl) throw Object.assign(new Error('Enter the server address first'), { status: 400 });
        if (!key && !p.keyOptional) throw Object.assign(new Error('Paste an API key first'), { status: 400 });
        // Check with the provider BEFORE saving, so a typo or a wrong address is never stored.
        const models = await clientFor(p.type).listModels({ apiKey: key, baseUrl, providerId: id });
        await this.engineCfg.setProvider(id, { key: typedKey || undefined, baseUrl, models: models.length });
        return { models: models.length, engine: this.engineCfg.publicView() };
      },
      'POST /api/engine/oauth/start': async ({ body }) => {
        const provider = body.provider || 'openrouter';
        if (provider === 'xai') {
          const { url, state } = oauthXai.startXai({ config: this.engineCfg });
          if (oauthXai.isXaiAuthUrl(url)) openExternal(url);
          return { url, state, provider };
        }
        const { url, state } = oauth.startOpenRouter({ port: this.port });
        if (oauth.isOpenRouterAuthUrl(url)) openExternal(url);
        return { url, state, provider };
      },
      'GET /api/engine/oauth/status': async ({ q }) => {
        const or = oauth.oauthStatus(q.state);
        if (or.status !== 'unknown') return { ...or, engine: this.engineCfg.publicView() };
        return { ...oauthXai.oauthStatus(q.state), engine: this.engineCfg.publicView() };
      },
      'POST /api/engine/oauth/cancel': async ({ body }) => {
        oauth.cancelOAuth(body.state);
        oauthXai.cancelOAuth(body.state);
        return {};
      },
      'POST /api/engine/provider/clear': async ({ body }) => {
        this.engineCfg.clearProvider(String(body.id || ''));
        return { engine: this.engineCfg.publicView() };
      },
      'POST /api/engine/settings': async ({ body }) => {
        this.engineCfg.setApprovals(body.approvals);
        return { engine: this.engineCfg.publicView() };
      },
      // Models of every connected provider, for the "Models" section of Settings.
      'GET /api/engine/models': async () => {
        const ids = this.engineCfg.configuredIds();
        const errors = [];
        const lists = await Promise.all(
          ids.map(async (id) => {
            try {
              const list = await clientFor(this.engineCfg.type(id)).listModels({ apiKey: await this.engineCfg.getKey(id), baseUrl: this.engineCfg.baseUrl(id), providerId: id });
              return list.map((m) => ({ provider: id, providerName: this.engineCfg.provider(id).name, id: m.id, name: m.name || m.id }));
            } catch (e) {
              errors.push(`${this.engineCfg.provider(id).name}: ${e.message}`);
              return [];
            }
          }),
        );
        return { models: lists.flat(), errors };
      },
      // Default models for the roles: fast (titles, summaries, helper agents) and plan. '' = use the session's model.
      'POST /api/engine/models': async ({ body }) => {
        const bad = (m) => Object.assign(new Error(m), { status: 400 });
        const next = {};
        for (const role of ['fast', 'plan']) {
          if (body[role] === undefined) continue;
          const spec = String(body[role] || '').trim();
          if (spec) {
            const i = spec.indexOf('/');
            const pid = i > 0 ? spec.slice(0, i) : '';
            const p = this.engineCfg.provider(pid);
            if (!p) throw bad(`Write the ${role} model as provider/model-id, for example anthropic/claude-haiku-4-5 (pick one from the list).`);
            if (!this.engineCfg.configured(pid)) throw bad(`${p.name} is not set up. Add it in Settings → AI providers first.`);
            let list;
            try {
              list = await clientFor(p.type).listModels({ apiKey: await this.engineCfg.getKey(pid), baseUrl: this.engineCfg.baseUrl(pid), providerId: pid });
            } catch (e) {
              throw bad(`Could not load the models of ${p.name} to check "${spec}": ${e.message}`);
            }
            if (!list.some((m) => m.id === spec.slice(i + 1))) throw bad(`${p.name} has no model "${spec.slice(i + 1)}". Pick one from the list.`);
          }
          next[role] = spec;
        }
        this.engineCfg.setRoles(next);
        return { engine: this.engineCfg.publicView() };
      },
      // Web search service for the web_search tool. The service is tried once before anything is saved.
      'POST /api/engine/search': async ({ body }) => {
        const provider = String(body.provider || '');
        const typed = body.key ? String(body.key).trim() : '';
        const baseUrl = provider === 'searxng' ? String(body.baseUrl || '').trim() : '';
        const old = this.engineCfg.data.search?.provider === provider ? await this.engineCfg.searchConfig().catch(() => null) : null;
        const apiKey = typed || old?.apiKey || null;
        if (provider !== 'searxng' && !apiKey) throw Object.assign(new Error('Paste an API key first'), { status: 400 });
        if (provider === 'searxng' && !/^https?:\/\//i.test(baseUrl || old?.baseUrl || '')) throw Object.assign(new Error('The SearXNG address must start with http:// or https://'), { status: 400 });
        const r = await webSearch({ query: 'ORBIX test', count: 1 }, { provider, apiKey, baseUrl: provider === 'searxng' ? baseUrl || old?.baseUrl : '' });
        if (r.isError) throw Object.assign(new Error(r.text), { status: 400 });
        try {
          await this.engineCfg.setSearch({ provider, key: typed || undefined, baseUrl });
        } catch (e) {
          throw Object.assign(e, { status: 400 });
        }
        return { engine: this.engineCfg.publicView() };
      },
      'POST /api/engine/search/clear': async () => {
        this.engineCfg.clearSearch();
        return { engine: this.engineCfg.publicView() };
      },
      // Hooks (read-only here): your hooks.json and the project's .orbix/hooks.json.
      'GET /api/hooks': async ({ q }) => {
        const view = (r) => ({ file: r.file, exists: r.exists, errors: r.errors, hooks: listHooks(r) });
        const user = readHooksFile(userHooksPath());
        let project = null;
        if (q.ws) {
          const root = this.backend.hostPath(q.ws);
          const r = readHooksFile(projectHooksPath(root));
          project = { ...view(r), trusted: r.count ? hooksTrusted(this.backend.keyPath(q.ws), r.hooks) : null };
        }
        return { user: view(user), project };
      },
      'POST /api/hooks/reveal': async ({ body }) => {
        let target;
        if (body.scope === 'project') {
          if (!body.ws) throw Object.assign(new Error('Open a session first'), { status: 400 });
          const root = this.backend.hostPath(String(body.ws));
          const f = projectHooksPath(root);
          target = fs.existsSync(f) ? f : fs.existsSync(path.dirname(f)) ? path.dirname(f) : root;
        } else {
          const f = userHooksPath();
          if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ hooks: {} }, null, 2) + '\n');
          target = f;
        }
        await fsapi.reveal(this.backend, target);
        return { path: target };
      },
      'GET /api/diagnostics': async () => ({ report: await collectDiagnostics(this) }),
      'POST /api/sessions/delete': async ({ body }) => {
        const paths = Array.isArray(body.paths) ? body.paths : [];
        if (!paths.length || paths.length > 500) throw Object.assign(new Error('Nothing to delete'), { status: 400 });
        const busy = [...this.procs.values()].find((p) => (p.opts.resume && paths.includes(p.opts.resume)) || (p.session?.file && paths.includes(p.session.file)));
        if (busy) throw Object.assign(new Error('That conversation is open. Close it first.'), { status: 409 });
        // Only ORBIX's own conversation files can be deleted; any other path is refused before anything is removed.
        if (!paths.every(isAgentSessionPath)) throw Object.assign(new Error('Only ORBIX conversations can be deleted'), { status: 400 });
        return { removed: await deleteAgentSessions(paths) };
      },

      'POST /api/proc/start': async ({ body }) => {
        const proc = await this.startProc({ workspace: body.workspace, resume: body.resume, model: body.model, noSession: !!body.noSession });
        return { engine: 'builtin', id: proc.id, workspace: proc.workspace, protocol: proc.protocol, commands: proc.cache.commands, notice: null };
      },
      'POST /api/proc/stop': async ({ body }) => {
        const p = this.procs.get(body.proc);
        if (p) await p.stop(3000);
        return {};
      },
      'GET /api/procs': async () => ({ procs: this.procList() }),
      'GET /api/proc/ui': async ({ q }) => ({ requests: [...this.proc(q.proc).openUi.values()] }),

      'POST /api/rpc': async ({ body }) => {
        const proc = this.proc(body.proc);
        if (!body.cmd || typeof body.cmd.type !== 'string') throw Object.assign(new Error('cmd.type required'), { status: 400 });
        try {
          const res = await proc.request(body.cmd, Number.isFinite(body.timeout) ? body.timeout : 600000);
          return { response: shapeResponse(body.cmd.type, res) };
        } catch (e) {
          return { ok: false, error: e.message, code: e.code };
        }
      },

      'POST /api/reply': async ({ body }) => {
        const proc = this.proc(body.proc);
        const t = body.msg?.type;
        if (t !== 'extension_ui_response') throw Object.assign(new Error('Unsupported reply type'), { status: 400 });
        proc.send(body.msg);
        if (t === 'extension_ui_response') proc.openUi?.delete(body.msg.id);
        return {};
      },

      'GET /api/events': ({ req, res }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS });
        res.write(`retry: 1500\n\n`);
        res.write(`data: ${JSON.stringify({ g: 'hello', procs: this.procList(), t: Date.now() })}\n\n`);
        this.clients.add(res);
        this.hadClient = true;
        req.on('close', () => {
          this.clients.delete(res);
          this.lastClientAt = Date.now();
        });
        return undefined;
      },

      'GET /api/fs/list': async ({ q }) => ({ listing: await fsapi.listDir(this.backend, q.path || '', { dirsOnly: q.dirs === '1' }) }),
      'GET /api/fs/read': async ({ q }) => ({ file: await fsapi.readFile(this.backend, q.path) }),
      'GET /api/fs/find': async ({ q }) => ({ files: await fsapi.findFiles(this.backend, wsPath(q), q.q || '') }),
      'POST /api/fs/reveal': async ({ body }) => {
        await fsapi.reveal(this.backend, String(body.path || ''));
        return {};
      },

      'GET /api/git/status': async ({ q }) => ({ git: await gitapi.status(this.backend, wsPath(q)) }),
      'GET /api/git/diff': async ({ q }) => ({ diff: await gitapi.diff(this.backend, wsPath(q), q.file, { untracked: q.untracked === '1' }) }),
      'GET /api/git/log': async ({ q }) => ({ log: await gitapi.log(this.backend, wsPath(q)) }),
      'POST /api/git/stage': async ({ body }) => (await gitapi.stage(this.backend, wsPath(body), body.paths), {}),
      'POST /api/git/unstage': async ({ body }) => (await gitapi.unstage(this.backend, wsPath(body), body.paths), {}),
      'POST /api/git/discard': async ({ body }) => (await gitapi.discard(this.backend, wsPath(body), { tracked: body.tracked, untracked: body.untracked }), {}),
      'POST /api/git/commit': async ({ body }) => ({ commit: await gitapi.commit(this.backend, wsPath(body), body.message) }),

      'POST /api/open-url': async ({ body }) => {
        try {
          openExternal(safeLink(body.url));
        } catch (e) {
          throw Object.assign(e, { status: 400 });
        }
        return {};
      },

      'POST /api/quit': async () => {
        setTimeout(() => this.onQuit?.(), 100);
        return {};
      },
    };
  }
}

function stripPartial(a) {
  const { partial, ...rest } = a;
  return rest;
}
