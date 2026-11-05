// Provider sign-in that works without an open chat session.
// Runs one private, session-less `omp --mode rpc-ui` process and drives OMP's own
// login / logout RPC commands, so the provider list, OAuth flows and credential store
// are exactly the CLI's. API keys go through `omp auth import -` (OMP's transfer format).
import { OmpProc } from './proc.mjs';
import { log, safeLink } from './util.mjs';
import { openExternal } from './launcher.mjs';

const IDLE_MS = 5 * 60 * 1000;
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Some sign-ins can't run over RPC; OMP's error text says why.
 * 'key': the provider wants a secret typed in → offer the API-key form.
 * 'terminal': it asks setup questions first (e.g. Copilot's enterprise URL) → offer `omp login` in a terminal.
 */
function loginFallback(message) {
  if (/secret input/i.test(message || '')) return 'key';
  if (/interactive prompts|not supported in RPC mode|Use the terminal UI/i.test(message || '')) return 'terminal';
  return null;
}

/** stdin for `omp auth import -`: OMP's credential-transfer document (version 1). */
function apiKeyImportDoc(provider, key) {
  if (!PROVIDER_RE.test(provider || '')) throw new Error('Invalid provider id');
  const k = String(key ?? '').trim();
  if (!k) throw new Error('API key is empty');
  if (/\s/.test(k)) throw new Error('An API key cannot contain spaces or line breaks');
  return JSON.stringify({ version: 1, credentials: [{ provider, credential: { type: 'api_key', key: k } }] });
}

export class AuthService {
  constructor({ backend, broadcast }) {
    this.backend = backend;
    this.broadcast = broadcast;
    this.p = null;
    this.starting = null;
    this.sig = '';
    this.login = null; // { provider, startedAt }
    this.requests = []; // pending extension_ui_request frames of the running login
    this.idleTimer = null;
  }

  get signature() {
    const b = this.backend;
    return `${b.kind}|${b.distro}|${b.ompPath}`;
  }

  emit(e) {
    this.broadcast({ g: 'auth', e });
  }

  async proc() {
    this.touch();
    if (this.p && !this.p.exited && this.sig === this.signature) return this.p;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await this.stop();
      const home = await this.backend.home();
      const p = new OmpProc({ id: 'auth', backend: this.backend, workspace: home, noSession: true, extraArgs: ['--no-title', '--no-lsp'] });
      p.on('event', (ev) => this.onEvent(ev));
      p.on('exit', () => {
        if (this.p === p) this.p = null;
        if (this.login) this.finishLogin(false, 'The sign-in process stopped.');
      });
      try {
        await p.start();
      } catch (e) {
        await p.stop(500).catch(() => {});
        throw e;
      }
      this.p = p;
      this.sig = this.signature;
      return p;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => !this.login && this.stop(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  async stop() {
    const p = this.p;
    this.p = null;
    if (p && !p.exited) await p.stop(1500).catch(() => {});
  }

  onEvent(ev) {
    if (ev.type !== 'extension_ui_request' || !this.login) return;
    if (ev.method === 'open_url') {
      // Open the provider's sign-in page in the user's default browser, where they are already logged in.
      try {
        openExternal(safeLink(ev.url));
      } catch (e) {
        log('auth open_url', e.message);
      }
      this.requests.push(ev);
      this.emit({ type: 'request', request: ev });
    } else if (['input', 'select', 'confirm', 'editor'].includes(ev.method)) {
      this.requests.push(ev);
      this.emit({ type: 'request', request: ev });
    } else if (ev.method === 'cancel') {
      this.requests = this.requests.filter((r) => r.id !== ev.targetId);
      this.emit({ type: 'cancel', id: ev.targetId });
    } else if (ev.method === 'notify') {
      this.emit({ type: 'progress', message: ev.message || '' });
    }
  }

  status() {
    return { login: this.login, requests: this.requests };
  }

  async providers() {
    const p = await this.proc();
    const r = await p.request({ type: 'get_login_providers' }, 60000);
    return r.data?.providers || [];
  }

  async startLogin(provider) {
    if (!PROVIDER_RE.test(provider || '')) throw Object.assign(new Error('Invalid provider id'), { status: 400 });
    if (this.login) throw Object.assign(new Error(`Already signing in to ${this.login.provider}. Finish or cancel that first.`), { status: 409 });
    const p = await this.proc();
    this.login = { provider, startedAt: Date.now() };
    this.requests = [];
    this.emit({ type: 'login_start', provider });
    p.request({ type: 'login', providerId: provider }, 0).then(
      () => this.finishLogin(true),
      (e) => this.finishLogin(false, e.message),
    );
  }

  finishLogin(ok, error = '') {
    if (!this.login) return;
    const { provider } = this.login;
    this.login = null;
    this.requests = [];
    this.touch();
    this.emit({ type: 'login_end', provider, ok, error, fallback: ok ? null : loginFallback(error) });
  }

  /** Cancelling a browser-callback flow has no RPC command, so restart the private process. */
  async cancelLogin() {
    if (!this.login) return;
    this.finishLogin(false, 'Cancelled');
    await this.stop();
  }

  reply(msg) {
    if (!this.p || this.p.exited) throw Object.assign(new Error('No sign-in in progress'), { status: 409 });
    if (msg?.type !== 'extension_ui_response' || typeof msg.id !== 'string') throw Object.assign(new Error('Bad reply'), { status: 400 });
    this.requests = this.requests.filter((r) => r.id !== msg.id);
    this.p.send(msg);
  }

  async accounts(provider) {
    if (!PROVIDER_RE.test(provider || '')) throw Object.assign(new Error('Invalid provider id'), { status: 400 });
    const p = await this.proc();
    const r = await p.request({ type: 'get_logout_accounts', providerId: provider }, 30000);
    return r.data?.accounts || [];
  }

  async logout(provider, credentialId) {
    if (!PROVIDER_RE.test(provider || '') || !Number.isInteger(credentialId)) throw Object.assign(new Error('Invalid account'), { status: 400 });
    const p = await this.proc();
    const r = await p.request({ type: 'logout', providerId: provider, credentialId }, 30000);
    return r.data || {};
  }

  async setApiKey(provider, key) {
    const doc = apiKeyImportDoc(provider, key);
    const bin = await this.backend.resolveOmp();
    if (!bin) throw new Error('OMP binary not found');
    const r = await this.backend.exec([bin, 'auth', 'import', '-'], { input: doc, timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr.toString('utf8') || r.stdout.toString('utf8')).trim() || 'omp auth import failed');
    // The private process caches credential sources; restart it so the next listing is fresh.
    if (!this.login) await this.stop();
  }

  async openTerminalLogin(provider) {
    if (!PROVIDER_RE.test(provider || '')) throw Object.assign(new Error('Invalid provider id'), { status: 400 });
    const bin = await this.backend.resolveOmp();
    if (!bin) throw new Error('OMP binary not found');
    this.backend.openTerminal([bin, 'login', provider]);
  }

  /** Subscription / plan limits for every signed-in account (`omp usage --json`). */
  async usage() {
    const bin = await this.backend.resolveOmp();
    if (!bin) throw new Error('OMP binary not found');
    const r = await this.backend.exec([bin, 'usage', '--json'], { timeout: 60000 });
    const text = r.stdout.toString('utf8');
    try {
      return JSON.parse(text.slice(text.indexOf('{'))).reports || [];
    } catch {
      throw new Error(r.stderr.toString('utf8').trim() || 'omp usage returned no data');
    }
  }
}
