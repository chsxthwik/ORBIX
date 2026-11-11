// Provider sign-ins: "Sign in with ChatGPT" (browser, calls back to a fixed local port) and "Sign in with xAI"
// (device code: the user confirms a short code on x.ai, nothing listens locally).
//
// Neither OpenAI nor xAI registers third-party apps for OAuth. Both flows use the public client registration of the
// vendor's own command-line tool, so they can stop working whenever the vendor changes it:
//   ChatGPT: OpenAI Codex CLI (github.com/openai/codex, codex-rs/login). The access token is used with the ChatGPT
//            plan, as Codex does in ChatGPT mode (chatgpt.mjs), and refreshed before it expires. No API key and no
//            OpenAI Platform organization are needed.
//   xAI:     the Grok CLI client, with the OAuth device flow opencode uses (auth.x.ai/oauth2/device/code). The access
//            token is used as the API key and refreshed before it expires.
// The ChatGPT callback uses the redirect Codex registers (http://localhost:1455/auth/callback) and listens on the
// loopback addresses only (127.0.0.1, and ::1 when the system has it), for one sign-in at a time, closing when done.
// If the browser cannot reach it, the address the browser landed on can be pasted into ORBIX instead.
import http from 'node:http';
import crypto from 'node:crypto';
import { clientFor, presetById } from './providers.mjs';
import { jwtClaims, chatgptAuth } from './chatgpt.mjs';
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

/** When an access token stops working: expires_in when given, else the token's own exp claim. */
const tokenExpiry = (tokens) => expiresAt(tokens) || (Number(jwtClaims(tokens.access_token)?.exp) > 0 ? Number(jwtClaims(tokens.access_token).exp) * 1000 : null);

export const SPECS = {
  chatgpt: {
    name: 'ChatGPT',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    host: 'auth.openai.com',
    redirectHost: 'localhost', // exactly the redirect the Codex client is registered with
    scope: 'openid profile email offline_access',
    ports: [1455, 1457],
    path: '/auth/callback',
    extra: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs' },
    async finish(tokens) {
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('OpenAI did not return an access token.');
      const auth = chatgptAuth(tokens.id_token) || chatgptAuth(tokens.access_token);
      if (!auth?.accountId) throw new Error('This OpenAI account has no ChatGPT workspace. Sign in with the account that has your ChatGPT plan.');
      return { key: tokens.access_token, refresh: tokens.refresh_token || null, expiresAt: tokenExpiry(tokens) };
    },
    async refresh(refreshToken, spec) {
      const r = await fetch(spec.token, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_id: spec.clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: 'openid profile email' }), signal: AbortSignal.timeout(30000) });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) throw new Error(`Renewing the ChatGPT sign-in: ${t.error_description || t.error?.message || t.error || `the server answered ${r.status}`}`);
      return { key: t.access_token, refresh: t.refresh_token || refreshToken, expiresAt: tokenExpiry(t) };
    },
  },
  xai: {
    name: 'xAI',
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    device: 'https://auth.x.ai/oauth2/device/code',
    token: 'https://auth.x.ai/oauth2/token',
    host: 'accounts.x.ai', // where the user confirms the code
    scope: 'openid profile email offline_access grok-cli:access api:access',
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
    if (v.status === 'pending' && now - v.created > (v.ttl || TTL)) Object.assign(v, { status: 'expired', error: 'The sign-in took longer than 10 minutes. Try again.' });
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
      // "localhost" can resolve to ::1 first; answer there too when the system has IPv6 loopback (best effort).
      const v6 = http.createServer((req, res) => onCallback(req, res, port, config).catch((e) => page(res, 500, 'Sign-in failed', e.message)));
      v6.on('error', () => {});
      v6.on('clientError', (_e, socket) => socket.destroy());
      v6.listen(port, '::1');
      srv.on('close', () => v6.close(() => {}));
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
  if (!spec || spec.device) throw new Error('Unknown sign-in');
  prune();
  for (const [k, v] of pending) if (v.id === id && v.status === 'pending') pending.delete(k); // one sign-in per provider at a time
  const port = await listen(spec, config, ports || spec.ports);
  const verifier = b64url(crypto.randomBytes(64));
  const state = b64url(crypto.randomBytes(32));
  const redirect = `http://${spec.redirectHost || '127.0.0.1'}:${port}${spec.path}`;
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
  pending.set(state, { id, verifier, redirect, port, created: Date.now(), status: 'pending', error: '', config });
  return { url: u.toString(), state };
}

/** Exchange the code, check the account, count its models and save the sign-in. Used by the callback and by a pasted address. */
async function exchange(p, code) {
  const spec = SPECS[p.id];
  p.status = 'exchanging'; // one-time: a second answer with the same state is refused
  const verifier = p.verifier;
  p.verifier = null;
  const tokens = await postForm(spec.token, { grant_type: 'authorization_code', client_id: spec.clientId, code, redirect_uri: p.redirect, code_verifier: verifier }, 'Finishing the sign-in');
  const got = await spec.finish(tokens, spec);
  await save(p, got);
}
async function save(p, got) {
  const pr = presetById(p.id);
  const models = await clientFor(pr.type).listModels({ apiKey: got.key, baseUrl: p.config.baseUrl(p.id) || pr.baseUrl, providerId: p.id }).then((m) => m.length, () => undefined);
  await p.config.setProvider(p.id, { key: got.key, models, via: 'oauth', refresh: got.refresh || null, expiresAt: got.expiresAt || null });
  Object.assign(p, { status: 'done', models });
}

/**
 * Finish a browser sign-in from the address the browser ended on (for when it could not reach ORBIX's local port).
 * The address must carry the same one-time state the sign-in started with.
 */
export async function finishFromUrl(state, pasted) {
  prune();
  const p = pending.get(String(state || ''));
  if (!p || p.kind === 'device' || p.status !== 'pending') throw Object.assign(new Error('This sign-in is no longer waiting. Start it again.'), { status: 400 });
  let u;
  try {
    u = new URL(String(pasted || '').trim());
  } catch {
    throw Object.assign(new Error("Paste the full address from the browser's address bar."), { status: 400 });
  }
  if (u.searchParams.get('state') !== state) throw Object.assign(new Error('That address belongs to a different sign-in. Paste the address from this sign-in.'), { status: 400 });
  const code = u.searchParams.get('code');
  if (!code) throw Object.assign(new Error(u.searchParams.get('error_description') || u.searchParams.get('error') || 'That address has no sign-in code in it.'), { status: 400 });
  if (!CODE_RE.test(code)) throw Object.assign(new Error('The sign-in code in that address is not valid.'), { status: 400 });
  try {
    await exchange(p, code);
  } catch (e) {
    Object.assign(p, { status: 'error', error: e.message });
    throw Object.assign(e, { status: 502 });
  } finally {
    setTimeout(() => closeIfIdle(p.port), 300);
  }
  return { models: p.models };
}

// ---- device code (xAI) ----
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a device-code sign-in: returns the page to open, the code the user confirms there, and the state to poll with. */
export async function startDevice(id, { config, minInterval = 1000 } = {}) {
  const spec = SPECS[id];
  if (!spec?.device) throw new Error('Unknown sign-in');
  prune();
  for (const [k, v] of pending) {
    if (v.id === id && v.status === 'pending') {
      v.status = 'cancelled';
      pending.delete(k);
    }
  }
  const d = await postForm(spec.device, { client_id: spec.clientId, scope: spec.scope }, `Starting the ${spec.name} sign-in`);
  if (!d.device_code || !d.user_code) throw new Error(`${spec.name} did not return a sign-in code. Try again.`);
  const url = d.verification_uri_complete || d.verification_uri;
  const state = b64url(crypto.randomBytes(32));
  const ttl = Math.min(TTL, (Number(d.expires_in) || 600) * 1000);
  const p = { id, kind: 'device', created: Date.now(), ttl, status: 'pending', error: '', config, userCode: d.user_code, url, deviceCode: d.device_code };
  pending.set(state, p);
  const every = d.interval != null && Number(d.interval) >= 0 ? Number(d.interval) : 5; // seconds, as the provider asks
  poll(p, spec, Math.max(minInterval, every * 1000));
  return { url, state, userCode: d.user_code };
}

async function poll(p, spec, wait) {
  while (p.status === 'pending') {
    await sleep(wait);
    if (p.status !== 'pending') return;
    if (Date.now() - p.created > p.ttl) return Object.assign(p, { status: 'expired', error: 'The code expired before it was confirmed. Start the sign-in again.' });
    let r, t;
    try {
      r = await fetch(spec.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form({ grant_type: DEVICE_GRANT, device_code: p.deviceCode, client_id: spec.clientId }), signal: AbortSignal.timeout(30000) });
      t = await r.json().catch(() => ({}));
    } catch {
      continue; // a network blip: ask again on the next tick
    }
    if (p.status !== 'pending') return;
    if (r.ok && t.access_token) {
      try {
        p.status = 'exchanging';
        await save(p, await spec.finish(t, spec));
      } catch (e) {
        Object.assign(p, { status: 'error', error: e.message });
      }
      return;
    }
    const err = t.error || '';
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      wait += 5000;
      continue;
    }
    const msg = err === 'access_denied' ? `The sign-in was declined on ${spec.host}.` : err === 'expired_token' ? 'The code expired before it was confirmed. Start the sign-in again.' : `${spec.name} sign-in failed: ${t.error_description || err || `the server answered ${r.status}`}`;
    return Object.assign(p, { status: err === 'expired_token' ? 'expired' : 'error', error: msg });
  }
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
  try {
    await exchange(p, code);
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
  return { status: p.status, error: p.error || '', models: p.models, ...(p.kind === 'device' ? { userCode: p.userCode, url: p.url } : {}) };
}

export function cancelPkce(state) {
  const p = pending.get(String(state || ''));
  if (!p) return;
  p.status = 'cancelled'; // stops a device-code poll
  pending.delete(String(state));
  if (p.port) closeIfIdle(p.port);
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

/** Refresh a provider's sign-in (ChatGPT, xAI). */
export async function refreshSignIn(id, refreshToken) {
  const spec = SPECS[id];
  if (!spec?.refresh) throw new Error(`${spec?.name || id} sign-ins do not refresh.`);
  return spec.refresh(refreshToken, spec);
}

/** Close every callback server (tests, shutdown). */
export function closeAll() {
  for (const s of servers.values()) s.close(() => {});
  servers.clear();
  for (const p of pending.values()) p.status = 'cancelled';
  pending.clear();
}
