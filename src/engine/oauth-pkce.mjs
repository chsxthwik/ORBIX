// Sign-ins that must call back to one fixed local port: "Sign in with ChatGPT" and "Sign in with xAI".
//
// Neither OpenAI nor xAI registers third-party apps for OAuth. Both flows use the public client registration of the
// vendor's own command-line tool, so they can stop working whenever the vendor changes it:
//   ChatGPT: OpenAI Codex CLI (github.com/openai/codex, codex-rs/login). After sign-in the ID token is exchanged
//            for an ordinary OpenAI API key, as Codex does. That needs an OpenAI Platform organization.
//   xAI:     the Grok CLI client found by community projects (openprx/prx, opencode-grok-auth). The access token is
//            used as the API key and refreshed before it expires.
// The callback server listens on 127.0.0.1 only, for one sign-in at a time per port, and closes when it is done.
import http from 'node:http';
import crypto from 'node:crypto';
import { clientFor, presetById } from './providers.mjs';
import { escapeHtml as esc } from '../util.mjs';

const form = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postForm(url, fields, what) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(fields), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${what}: ${j.error_description || j.error?.message || j.error || `the server answered ${r.status}`}`);
  return j;
}
const expiresAt = (tokens) => (Number(tokens.expires_in) > 0 ? Date.now() + Number(tokens.expires_in) * 1000 : null);

export const SPECS = {
  openai: {
    name: 'ChatGPT',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    host: 'auth.openai.com',
    scope: 'openid profile email offline_access',
    ports: [1455, 1457],
    path: '/auth/callback',
    extra: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' },
    // The ID token is traded for an API key, which does not expire and needs no refresh.
    async finish(tokens, spec) {
      if (!tokens.id_token) throw new Error('OpenAI did not return an ID token.');
      let j;
      try {
        j = await postForm(spec.token, {
          grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
          client_id: spec.clientId,
          requested_token: 'openai-api-key',
          subject_token: tokens.id_token,
          subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        }, 'Creating an API key');
      } catch (e) {
        throw new Error(`Signed in, but OpenAI did not create an API key for this account (${e.message.replace(/^Creating an API key: /, '')}). An API key needs an OpenAI Platform organization at platform.openai.com; a ChatGPT subscription on its own is not enough.`);
      }
      if (typeof j.access_token !== 'string' || !j.access_token) throw new Error('OpenAI did not return an API key.');
      return { key: j.access_token };
    },
  },
  xai: {
    name: 'xAI',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    authorize: 'https://auth.x.ai/oauth2/authorize',
    token: 'https://auth.x.ai/oauth2/token',
    host: 'auth.x.ai',
    scope: 'openid profile email offline_access grok-cli:access api:access',
    ports: [56121],
    path: '/callback',
    extra: { plan: 'generic' },
    nonce: true,
    async finish(tokens) {
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('xAI did not return an access token.');
      return { key: tokens.access_token, refresh: tokens.refresh_token || null, expiresAt: expiresAt(tokens) };
    },
    /** A fresh access token from a refresh token. */
    async refresh(refreshToken, spec) {
      const t = await postForm(spec.token, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: spec.clientId }, 'Refreshing the xAI sign-in');
      if (!t.access_token) throw new Error('xAI did not return a new access token.');
      return { key: t.access_token, refresh: t.refresh_token || refreshToken, expiresAt: expiresAt(t) };
    },
  },
};

const TTL = 10 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const pending = new Map(); // state -> { id, verifier, redirect, port, created, status, error, models }
const servers = new Map(); // port -> http.Server

function page(res, status, title, text) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:#0d0f13;color:#eef0f4}
@media (prefers-color-scheme: light){body{background:#f4f5f8;color:#12151b}}main{max-width:440px;padding:28px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(body);
}

function prune() {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (v.status === 'pending' && now - v.created > TTL) Object.assign(v, { status: 'expired', error: 'The sign-in took longer than 10 minutes. Try again.' });
    if (now - v.created > 2 * TTL) pending.delete(k);
  }
  for (const port of [...servers.keys()]) closeIfIdle(port);
}
function closeIfIdle(port) {
  if ([...pending.values()].some((p) => p.port === port && (p.status === 'pending' || p.status === 'exchanging'))) return;
  servers.get(port)?.close(() => {});
  servers.delete(port);
}

/** Listen on the first free port of the provider's list. A busy port gets a clear error instead of a dead link. */
async function listen(spec, config, ports) {
  for (const port of ports) {
    if (servers.has(port)) return port;
    const srv = http.createServer((req, res) => onCallback(req, res, port, config).catch((e) => page(res, 500, 'Sign-in failed', e.message)));
    srv.headersTimeout = 15000;
    srv.requestTimeout = 30000;
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => (srv.off('error', reject), resolve()));
      });
      srv.on('error', (e) => { // a later server error ends the sign-ins on this port instead of the process
        for (const p of pending.values()) if (p.port === port && p.status === 'pending') Object.assign(p, { status: 'error', error: 'The sign-in server stopped: ' + e.message });
        servers.get(port)?.close(() => {});
        servers.delete(port);
      });
      srv.on('clientError', (_e, socket) => socket.destroy());
      servers.set(port, srv);
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`Port ${ports.join(' and ')} ${ports.length > 1 ? 'are' : 'is'} in use, so ${spec.name} cannot send the sign-in back. Close the other program using it (for example a ${spec.name === 'ChatGPT' ? 'Codex CLI' : 'Grok CLI'} sign-in) and try again.`);
}

/** Start a sign-in: returns the URL to open and the state to poll with. `ports` overrides the list (tests). */
export async function startPkce(id, { config, ports } = {}) {
  const spec = SPECS[id];
  if (!spec) throw new Error('Unknown sign-in');
  prune();
  for (const [k, v] of pending) if (v.id === id && v.status === 'pending') pending.delete(k); // one sign-in per provider at a time
  const port = await listen(spec, config, ports || spec.ports);
  const verifier = b64url(crypto.randomBytes(64));
  const state = b64url(crypto.randomBytes(32));
  const redirect = `http://127.0.0.1:${port}${spec.path}`;
  const u = new URL(spec.authorize);
  const q = {
    response_type: 'code',
    client_id: spec.clientId,
    redirect_uri: redirect,
    scope: spec.scope,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
    ...(spec.nonce ? { nonce: b64url(crypto.randomBytes(16)) } : {}),
    ...spec.extra,
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  pending.set(state, { id, verifier, redirect, port, created: Date.now(), status: 'pending', error: '' });
  return { url: u.toString(), state };
}

async function onCallback(req, res, port, config) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p0 = pending.get(url.searchParams.get('state') || '');
  const spec = p0 && SPECS[p0.id];
  if (req.method !== 'GET' || !spec || url.pathname !== spec.path) return page(res, 404, 'Not found', 'This address only receives sign-ins started from ORBIX.');
  const state = url.searchParams.get('state');
  const p = STATE_RE.test(state) ? p0 : null;
  if (!p || p.status !== 'pending' || p.port !== port) return page(res, 400, 'Sign-in link not valid', 'This sign-in link was already used or was not started from ORBIX. Start again from the app.');
  const fail = (code, title, msg) => {
    Object.assign(p, { status: 'error', error: msg });
    setTimeout(() => closeIfIdle(port), 300);
    return page(res, code, title, msg);
  };
  if (Date.now() - p.created > TTL) return fail(400, 'Sign-in expired', 'The sign-in took longer than 10 minutes. Try again.');
  const code = url.searchParams.get('code');
  if (!code) return fail(400, 'Sign-in cancelled', url.searchParams.get('error_description') || url.searchParams.get('error') || 'No sign-in was completed. You can close this tab.');
  if (!CODE_RE.test(code)) return fail(400, 'Sign-in failed', 'The sign-in answer was not valid.');
  p.status = 'exchanging'; // one-time: a second request with the same state is refused
  const verifier = p.verifier;
  p.verifier = null;
  try {
    const tokens = await postForm(spec.token, { grant_type: 'authorization_code', client_id: spec.clientId, code, redirect_uri: p.redirect, code_verifier: verifier }, 'Finishing the sign-in');
    const got = await spec.finish(tokens, spec);
    const pr = presetById(p.id);
    const models = await clientFor(pr.type).listModels({ apiKey: got.key, baseUrl: config.baseUrl(p.id) || pr.baseUrl, providerId: p.id }).then((m) => m.length, () => undefined);
    await config.setProvider(p.id, { key: got.key, models, via: 'oauth', refresh: got.refresh || null, expiresAt: got.expiresAt || null });
    Object.assign(p, { status: 'done', models });
    setTimeout(() => closeIfIdle(port), 300);
    return page(res, 200, 'Signed in', `Signed in to ${spec.name}. You can close this tab and go back to ORBIX.`);
  } catch (e) {
    return fail(502, 'Sign-in failed', e.message);
  }
}

/** Where a sign-in stands: pending | exchanging | done | error | expired | unknown. */
export function pkceStatus(state) {
  prune();
  const p = pending.get(String(state || ''));
  if (!p) return { status: 'unknown' };
  return { status: p.status, error: p.error || '', models: p.models };
}

export function cancelPkce(state) {
  const p = pending.get(String(state || ''));
  if (!p) return;
  pending.delete(String(state));
  closeIfIdle(p.port);
}

/** Only the provider's own sign-in page may be opened by the sign-in route. */
export const isAuthUrl = (id, u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === SPECS[id]?.host;
  } catch {
    return false;
  }
};

/** Refresh a provider's sign-in, for providers that need it (xAI). */
export async function refreshSignIn(id, refreshToken) {
  const spec = SPECS[id];
  if (!spec?.refresh) throw new Error(`${spec?.name || id} sign-ins do not refresh.`);
  return spec.refresh(refreshToken, spec);
}

/** Close every callback server (tests, shutdown). */
export function closeAll() {
  for (const s of servers.values()) s.close(() => {});
  servers.clear();
  pending.clear();
}
