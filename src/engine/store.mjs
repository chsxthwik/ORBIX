// ORBIX agent storage, all inside the app's data folder:
//   data/engine.json               settings + API keys encrypted with DPAPI
//   data/sessions/<proj>/*.jsonl   saved conversations (append-only)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../store.mjs';
import { readJson, writeJson, uid, clip, makeTitle, pool, readHead, textOf } from '../util.mjs';
import { protect, unprotect } from './secrets.mjs';
import { PRESETS } from './providers.mjs';
import { setProviderOrg } from './openai.mjs';
import { refreshSignIn } from './oauth-pkce.mjs';
import { VERIFY_MODES } from './verify.mjs';

const SEARCH_PROVIDERS = ['brave', 'tavily', 'searxng'];
/** ask: edits and commands ask. edits: edits run, commands ask. auto: nothing asks. */
const APPROVAL_MODES = ['ask', 'edits', 'auto'];

/** A tidy trusted-command list: trimmed, single-spaced, no control characters, no duplicates, at most 100. */
export function cleanTrusted(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const c = String(x ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (c && c !== '*' && !out.includes(c)) out.push(c);
    if (out.length >= 100) break;
  }
  return out;
}

/**
 * Whether a shell command may run without asking because the user trusts it. A command that chains, pipes,
 * redirects or substitutes (; & | ` < > $( or a line break) never matches, so "npm test && rm -rf x" is not "npm test".
 */
export function isTrustedCommand(command, trusted) {
  const c = String(command ?? '').trim().replace(/\s+/g, ' ');
  if (!c || /[;&|`<>\r\n]|\$\(/.test(c)) return false;
  return (trusted || []).some((r) => (r.endsWith(' *') ? c === r.slice(0, -2) || c.startsWith(r.slice(0, -1)) : c === r));
}
/** A command that could be trusted at all (nothing chained, piped, redirected or substituted). */
export const trustableCommand = (command) => isTrustedCommand(command, [String(command ?? '').trim().replace(/\s+/g, ' ')]);

export class EngineConfig {
  constructor(dir = DATA_DIR) {
    this.file = path.join(dir, 'engine.json');
    const d = readJson(this.file, {});
    const str = (x) => (typeof x === 'string' ? x.trim() : '');
    const sr = d.search && typeof d.search === 'object' ? d.search : {};
    this.data = {
      approvals: APPROVAL_MODES.includes(d.approvals) ? d.approvals : 'ask',
      // Commands that run without asking: exact text, or a prefix ending in " *" ("npm run *").
      trusted: cleanTrusted(d.trusted),
      providers: d.providers && typeof d.providers === 'object' ? d.providers : {},
      defaultModel: d.defaultModel || '',
      // Model roles (defaults for every session): "provider/model" or '' (= the session's current model).
      models: { fast: str(d.models?.fast), plan: str(d.models?.plan) },
      // Web search: { provider: 'brave' | 'tavily' | 'searxng', key (DPAPI), baseUrl (SearXNG only) }
      search: SEARCH_PROVIDERS.includes(sr.provider) ? { provider: sr.provider, ...(sr.key ? { key: String(sr.key) } : {}), ...(sr.baseUrl ? { baseUrl: String(sr.baseUrl) } : {}) } : null,
      // Run-end checks after edits. verify: run the project's check command (off / ask / always); review: one pass
      // over the run's diff by the fast model. checkCommands: the check command chosen for a project, by key path
      // ('off' = this project has none).
      verify: VERIFY_MODES.includes(d.verify) ? d.verify : 'ask',
      review: d.review !== false,
      checkCommands: d.checkCommands && typeof d.checkCommands === 'object' ? Object.fromEntries(Object.entries(d.checkCommands).filter(([k, v]) => k && typeof v === 'string' && v.trim())) : {},
    };
    // Decrypted keys by their stored (encrypted) form: each DPAPI call starts PowerShell (~250 ms), so a key is
    // decrypted once per run instead of on every prompt. Plain keys stay in this process only.
    this.plain = new Map();
    for (const [id, p] of Object.entries(this.data.providers)) if (p?.orgId) setProviderOrg(id, p.orgId);
  }
  save() {
    writeJson(this.file, this.data);
  }
  provider(id) {
    return PRESETS.find((p) => p.id === id);
  }
  type(id) {
    return this.provider(id)?.type;
  }
  baseUrl(id) {
    const own = this.data.providers[id]?.baseUrl;
    return own || this.provider(id)?.baseUrl || '';
  }
  hasKey(id) {
    return !!this.data.providers[id]?.key;
  }
  /** Usable now: has a key, or is a no-key provider (Ollama, custom) the user switched on. */
  configured(id) {
    const p = this.provider(id);
    if (!p) return false;
    if (this.hasKey(id)) return true;
    return !!p.keyOptional && !!this.data.providers[id]?.enabled && !!this.baseUrl(id);
  }
  configuredIds() {
    return PRESETS.filter((p) => this.configured(p.id)).map((p) => p.id);
  }
  async getKey(id) {
    const own = this.data.providers[id];
    // A sign-in that expires is refreshed five minutes early, once at a time per provider.
    if (own?.refresh && own.expiresAt && Date.now() > own.expiresAt - 5 * 60 * 1000) await this._refresh(id).catch(() => {});
    const k = this.data.providers[id]?.key;
    if (!k) return null;
    if (!this.plain.has(k)) this.plain.set(k, await unprotect(k));
    return this.plain.get(k);
  }
  /**
   * Save a provider. `key` and `baseUrl` are optional; the caller verifies them with the provider first.
   * `models`: how many models the provider listed. `via`: 'oauth' when the key came from a sign-in.
   */
  _refresh(id) {
    this.refreshing ||= new Map();
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const job = (async () => {
      const cur = this.data.providers[id];
      try {
        const got = await refreshSignIn(id, await unprotect(cur.refresh));
        await this.setProvider(id, { key: got.key, via: 'oauth', refresh: got.refresh, expiresAt: got.expiresAt, orgId: got.orgId || cur.orgId });
      } catch (e) {
        // The sign-in can no longer be renewed: say so, so Settings can ask for a new sign-in.
        const now = this.data.providers[id];
        if (now) { now.signInError = String(e.message || e).slice(0, 300); this.save(); }
        throw e;
      } finally {
        this.refreshing.delete(id);
      }
    })();
    this.refreshing.set(id, job);
    return job;
  }
  /** True when this provider's key came from a sign-in. */
  isSignIn(id) {
    return this.data.providers[id]?.via === 'oauth';
  }
  /** Renew a sign-in now (the provider rejected its token) and return the new token, or null when it cannot be renewed. */
  async renewSignIn(id) {
    if (!this.data.providers[id]?.refresh) return null;
    await this._refresh(id);
    return this.getKey(id);
  }
  async setProvider(id, { key, baseUrl, models, via, refresh, expiresAt, orgId } = {}) {
    const p = this.provider(id);
    if (!p) throw new Error('Unknown provider');
    const cur = { ...(this.data.providers[id] || {}) };
    if (key != null && String(key).trim()) {
      const clean = String(key).trim();
      if (/\s/.test(clean)) throw new Error('An API key cannot contain spaces or line breaks');
      if (cur.key) this.plain.delete(cur.key);
      cur.key = await protect(clean);
      this.plain.set(cur.key, clean);
    }
    if (p.editableUrl || baseUrl) {
      const u = String(baseUrl ?? cur.baseUrl ?? '').trim();
      if (u && !/^https?:\/\//i.test(u)) throw new Error('The server address must start with http:// or https://');
      if (p.editableUrl) cur.baseUrl = u;
    }
    if (p.keyOptional) cur.enabled = true;
    if (Number.isFinite(models)) cur.models = models;
    if (key != null && String(key).trim()) {
      cur.via = via === 'oauth' ? 'oauth' : 'key';
      // The organization a sign-in chose (OpenCode); a pasted key carries its own.
      if (via === 'oauth' && orgId) cur.orgId = String(orgId);
      else delete cur.orgId;
      setProviderOrg(id, cur.orgId);
      // A new key replaces any earlier sign-in: keep a refresh token only if this key came with one.
      delete cur.signInError;
      if (refresh) {
        cur.refresh = await protect(String(refresh));
        cur.expiresAt = Number(expiresAt) || null;
      } else {
        delete cur.refresh;
        delete cur.expiresAt;
      }
    }
    cur.savedAt = Date.now();
    this.data.providers[id] = cur;
    this.save();
  }
  clearProvider(id) {
    const k = this.data.providers[id]?.key;
    if (k) this.plain.delete(k);
    delete this.data.providers[id];
    setProviderOrg(id, null);
    this.save();
  }
  setApprovals(mode) {
    this.data.approvals = APPROVAL_MODES.includes(mode) ? mode : 'ask';
    this.save();
  }
  setTrusted(list) {
    this.data.trusted = cleanTrusted(list);
    this.save();
  }
  addTrusted(command) {
    this.setTrusted([...(this.data.trusted || []), command]);
  }
  setChecks({ verify, review }) {
    if (verify !== undefined) this.data.verify = VERIFY_MODES.includes(verify) ? verify : 'ask';
    if (review !== undefined) this.data.review = !!review;
    this.save();
  }
  /** The check command chosen for a project ('' = find it from the project's files, 'off' = none). */
  checkCommand(keyPath) {
    return this.data.checkCommands?.[keyPath] || '';
  }
  setCheckCommand(keyPath, command) {
    // One line, like a trusted command: the check runs through the same shell and approvals as any command.
    const c = String(command ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 300);
    const all = { ...(this.data.checkCommands || {}) };
    if (c) all[keyPath] = c;
    else delete all[keyPath];
    this.data.checkCommands = all;
    this.save();
  }
  /** Model roles: { fast, plan } as "provider/model" strings ('' = use the session's model). */
  roles() {
    return { fast: this.data.models?.fast || '', plan: this.data.models?.plan || '' };
  }
  setRoles({ fast, plan }) {
    const cur = this.roles();
    this.data.models = { fast: fast === undefined ? cur.fast : String(fast || '').trim(), plan: plan === undefined ? cur.plan : String(plan || '').trim() };
    this.save();
  }
  searchReady() {
    const s = this.data.search;
    return !!s && (s.provider === 'searxng' ? !!s.baseUrl : !!s.key);
  }
  /** { provider, apiKey, baseUrl } for the search tool, or null. The key is decrypted here and goes nowhere else. */
  async searchConfig() {
    const s = this.data.search;
    if (!this.searchReady()) return null;
    let apiKey = null;
    if (s.key) {
      if (!this.plain.has(s.key)) this.plain.set(s.key, await unprotect(s.key));
      apiKey = this.plain.get(s.key);
    }
    return { provider: s.provider, apiKey, baseUrl: s.baseUrl || '' };
  }
  async setSearch({ provider, key, baseUrl }) {
    if (!SEARCH_PROVIDERS.includes(provider)) throw new Error('Choose Brave Search, Tavily or SearXNG');
    const cur = this.data.search?.provider === provider ? { ...this.data.search } : { provider };
    if (provider === 'searxng') {
      const u = String(baseUrl ?? cur.baseUrl ?? '').trim();
      if (!/^https?:\/\//i.test(u)) throw new Error('The SearXNG address must start with http:// or https://');
      if (/^https?:\/\/[^/]*@/i.test(u)) throw new Error('Leave the user name and password out of the address');
      cur.baseUrl = u.replace(/\/+$/, '');
    }
    if (key != null && String(key).trim()) {
      const clean = String(key).trim();
      if (/\s/.test(clean)) throw new Error('An API key cannot contain spaces or line breaks');
      if (cur.key) this.plain.delete(cur.key);
      cur.key = await protect(clean);
      this.plain.set(cur.key, clean);
    } else if (provider !== 'searxng' && !cur.key) throw new Error('Paste an API key first');
    if (this.data.search?.key && this.data.search.key !== cur.key) this.plain.delete(this.data.search.key);
    this.data.search = cur;
    this.save();
  }
  clearSearch() {
    if (this.data.search?.key) this.plain.delete(this.data.search.key);
    this.data.search = null;
    this.save();
  }
  /** What the UI may see: never the keys. */
  publicView() {
    const s = this.data.search;
    return {
      approvals: this.data.approvals,
      trusted: this.data.trusted || [],
      verify: this.data.verify,
      review: this.data.review,
      defaultModel: this.data.defaultModel,
      models: this.roles(),
      search: { provider: s?.provider || '', baseUrl: s?.baseUrl || '', hasKey: !!s?.key, configured: this.searchReady() },
      providers: PRESETS.map((p) => {
        const own = this.data.providers[p.id] || {};
        return { id: p.id, name: p.name, type: p.type, note: p.note || '', keyUrl: p.keyUrl || '', oauth: !!p.oauth, signInOnly: !!p.signInOnly, local: !!p.local, keyOptional: !!p.keyOptional, editableUrl: !!p.editableUrl, hasKey: this.hasKey(p.id), configured: this.configured(p.id), baseUrl: this.baseUrl(p.id), models: Number.isFinite(own.models) ? own.models : null, via: own.via || null, signInError: own.signInError || null };
      }),
    };
  }
}

const sessionsDir = () => path.join(DATA_DIR, 'sessions');

function projectFolder(keyPath) {
  return crypto.createHash('sha1').update(keyPath).digest('hex').slice(0, 10);
}

export function createSession({ cwd, keyPath, model, provider }) {
  const id = uid('b');
  const dir = path.join(sessionsDir(), projectFolder(keyPath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const header = { type: 'session', engine: 'builtin', version: 1, id, cwd, model: model || '', provider: provider || '', timestamp: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(header) + '\n');
  return { id, file, header };
}

/** If the last line was cut off (crash or power loss mid-write), end it so the next entry starts on its own line. */
export function repairTail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    if (size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a) fs.writeSync(fd, '\n', size);
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Open append handles per session file: an append through a held handle costs ~6 us, a fresh appendFileSync
// (open + write + close, scanned by antivirus on Windows) ~140 us. At most MAX_OPEN stay open.
const MAX_OPEN = 32;
const handles = new Map(); // file -> fd, oldest first

export function appendEntry(file, entry) {
  let fd = handles.get(file);
  if (fd === undefined) {
    if (handles.size >= MAX_OPEN) closeSession(handles.keys().next().value);
    fd = fs.openSync(file, 'a');
  } else handles.delete(file); // re-insert below: most recently used last
  handles.set(file, fd);
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
  } catch (e) {
    closeSession(file);
    throw e;
  }
}

/** Close the held append handle of a session file (when its session stops, or before deleting it). */
export function closeSession(file) {
  const fd = handles.get(file);
  if (fd === undefined) return;
  handles.delete(file);
  try {
    fs.closeSync(fd);
  } catch {}
}

export function loadSession(file) {
  const messages = [];
  let header = null;
  let title = '';
  const undone = [];
  const checkpoints = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a torn last line from a crash is ignored
    }
    if (o.type === 'session') header = o;
    else if (o.type === 'title') title = o.title;
    else if (o.type === 'undone') undone.push(o.toolCallId);
    else if (o.type === 'checkpoint') checkpoints.push({ toolCallId: o.toolCallId, undo: o.undo });
    else if (o.type === 'message' && o.message) messages.push(o.message);
  }
  return { header, messages, title, undone, checkpoints };
}

/** Header facts of a saved conversation from its first bytes: { header, title, first } (first user text). */
export function parseAgentHead(text) {
  let header = null;
  let title = '';
  let first = '';
  for (const line of text.split('\n').slice(0, -1)) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'session') header = o;
    else if (o.type === 'title') title = o.title;
    else if (o.type === 'message' && o.message?.role === 'user' && !first) first = textOf(o.message.content).replace(/\s+/g, ' ').trim();
  }
  return { header, title, first };
}

const listCache = new Map(); // file -> { mtime, size, head }

/** Session-list entries (id, path, cwd, title, mtime, size, chain, engine: 'builtin'). Unchanged files are not re-read. */
export async function listAgentSessions(backend) {
  const root = sessionsDir();
  let dirs;
  try {
    dirs = (await fs.promises.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const files = (
    await pool(dirs, 8, async (d) => (await fs.promises.readdir(path.join(root, d.name))).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(root, d.name, n)))
  ).flatMap((x) => x || []);
  const rows = await pool(files, 16, async (file) => {
    const st = await fs.promises.stat(file);
    let hit = listCache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs || hit.size !== st.size) {
      hit = { mtime: st.mtimeMs, size: st.size, head: parseAgentHead(await readHead(file, 65536)) };
      listCache.set(file, hit);
    }
    const { header, title, first } = hit.head;
    if (!header) return null;
    return { id: header.id, path: file, engine: 'builtin', cwd: header.cwd, cwdKey: backend.keyPath(header.cwd), cwdDisplay: backend.displayPath(header.cwd), title: makeTitle(title || first) || 'Untitled', preview: clip(first, 140), mtime: st.mtimeMs, size: st.size, chain: [file], chainIds: [header.id], resumes: 0 };
  });
  const live = new Set(files);
  for (const k of listCache.keys()) if (!live.has(k)) listCache.delete(k);
  return rows.filter(Boolean);
}

/** Delete saved agent conversations. Only files directly inside data/sessions/<project>/ are accepted. */
export async function deleteAgentSessions(paths) {
  const root = path.resolve(sessionsDir());
  // Validate every path before deleting anything, so a bad entry never leaves a half-done batch.
  const files = paths.map((p) => {
    if (typeof p !== 'string' || !p.endsWith('.jsonl')) throw Object.assign(new Error('Not a session file'), { status: 400 });
    const file = path.resolve(p);
    if (path.dirname(path.dirname(file)) !== root) throw Object.assign(new Error('Refusing to delete outside the sessions folder'), { status: 403 });
    return file;
  });
  for (const file of files) {
    closeSession(file);
    await fs.promises.rm(file, { force: true });
  }
  return files.length;
}

export const isAgentSessionPath = (p) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(sessionsDir()) + path.sep);

/**
 * Copy a saved conversation into a new session file, keeping everything before the message at `index`
 * (an index into the message list as rebuildSession sees it, compaction markers included; `index` equal to the
 * message count copies it all). Settings, checkpoints and compaction entries before the cut are copied as they are,
 * so the new session resumes exactly like the original did at that point. Files on disk are not touched.
 * Returns { id, file, count }.
 */
export function branchSession(file, index, { title = '' } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // Replay like rebuildSession: slots[k] = the line that put message k in the list.
  const slots = [];
  const parsed = lines.map((line, n) => {
    if (!line.trim()) return null;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return null;
    }
    if (o.type === 'message' && o.message) slots.push(n);
    else if (o.type === 'compaction' && typeof o.summary === 'string') slots.splice(Math.max(0, slots.length - Math.max(0, o.keptCount | 0)), 0, n);
    else if (o.type === 'rewind' && Number.isInteger(o.count) && o.count >= 0) slots.length = Math.min(slots.length, o.count);
    return o;
  });
  if (!Number.isInteger(index) || index < 0 || index > slots.length) throw new Error('That message was not found in this conversation.');
  const cut = index === slots.length ? lines.length : slots[index];
  const header = parsed.find((o) => o?.type === 'session');
  if (!header) throw new Error('That saved conversation could not be read');
  const id = uid('b');
  const dir = path.dirname(file);
  const out = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const body = [JSON.stringify({ ...header, id, timestamp: new Date().toISOString(), branchOf: header.id })];
  for (let n = 0; n < cut; n++) if (parsed[n] && parsed[n].type !== 'session') body.push(lines[n]);
  if (title) body.push(JSON.stringify({ type: 'title', title }));
  fs.writeFileSync(out, body.join('\n') + '\n');
  return { id, file: out, count: index };
}
