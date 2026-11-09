// "Sign in with xAI": unofficial PKCE flow using the Grok CLI's public client registration.
// xAI has no public OAuth for third-party apps; this reuses the Grok CLI client ID that community
// projects found (openprx/prx, opencode-grok-auth). It can break at any time if xAI revokes it.
// The client ID is registered with a fixed redirect URI on port 56121, so a temporary server
// listens there for the callback instead of using the main ORBIX port.
import http from 'node:http';
import crypto from 'node:crypto';
import { clientFor, presetById } from './providers.mjs';
import { escapeHtml as esc } from '../util.mjs';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ENDPOINTS = { auth: 'https://auth.x.ai/oauth2/authorize', token: 'https://auth.x.ai/oauth2/token' };
const SCOPES = 'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_PORT = 56121;
const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const TTL = 10 * 60 * 1000;
const pending = new Map();
const STATE_RE = /^[A-Za-z0-9_-]{32}$/;
const CODE_RE = /^[A-Za-z0-9._~-]{1,2048}$/;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function prune() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.created > 2 * TTL) pending.delete(k);
}

let cbServer = null;

function ensureCallbackServer(config) {
  if (cbServer) return;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
    if (req.method !== 'GET' || !url.pathname.startsWith('/callback')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    await handleCallback(url, res, config);
    // Shut down after a short delay so the response is sent.
    setTimeout(stopCallbackServer, 500);
  });
  srv.listen(CALLBACK_PORT, '127.0.0.1');
  srv.on('error', () => { cbServer = null; });
  cbServer = srv;
  // Auto-close after TTL so we never leak the server.
  setTimeout(stopCallbackServer, TTL + 5000);
}

function stopCallbackServer() {
  if (!cbServer) return;
  cbServer.close(() => {});
  cbServer = null;
}

export function startXai({ config }) {
  prune();
  const live = [...pending.values()].filter((p) => p.status === 'pending');
  if (live.length >= 5) for (const [k, v] of pending) if (v.status === 'pending') pending.delete(k);
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(16));
  pending.set(state, { verifier, created: Date.now(), status: 'pending', error: '' });
  try {
    ensureCallbackServer(config);
  } catch (e) {
    pending.delete(state);
    throw new Error(`Cannot listen on port ${CALLBACK_PORT} for the xAI callback: ${e.message}`);
  }
  const u = new URL(ENDPOINTS.auth);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', CALLBACK_URI);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('plan', 'generic');
  return { url: u.toString(), state };
}

export function oauthStatus(state) {
  const p = pending.get(String(state || ''));
  if (!p) return { status: 'unknown' };
  if (p.status === 'pending' && Date.now() - p.created > TTL) return { status: 'expired', error: 'The sign-in took longer than 10 minutes. Try again.' };
  return { status: p.status, error: p.error || '', models: p.models };
}

export function cancelOAuth(state) {
  pending.delete(String(state || ''));
  if (!pending.size) stopCallbackServer();
}

function page(res, status, title, text) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 "Segoe UI",system-ui,sans-serif;background:#0d0f13;color:#eef0f4}
@media (prefers-color-scheme: light){body{background:#f4f5f8;color:#12151b}}main{max-width:420px;padding:28px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

async function handleCallback(url, res, config) {
  const state = url.searchParams.get('state') || '';
  const p = STATE_RE.test(state) ? pending.get(state) : undefined;
  if (!state || !p || p.status !== 'pending') return page(res, 400, 'Sign-in link not valid', 'This sign-in link was already used or was not started from ORBIX. Start again from the app.');
  if (Date.now() - p.created > TTL) {
    p.status = 'error';
    p.error = 'The sign-in took longer than 10 minutes. Try again.';
    return page(res, 400, 'Sign-in expired', p.error);
  }
  const code = url.searchParams.get('code');
  if (code && !CODE_RE.test(code)) {
    p.status = 'error';
    p.error = 'The sign-in answer was not valid.';
    return page(res, 400, 'Sign-in failed', p.error);
  }
  if (!code) {
    p.status = 'error';
    p.error = url.searchParams.get('error_description') || url.searchParams.get('error') || 'Sign-in was cancelled.';
    return page(res, 400, 'Sign-in cancelled', p.error);
  }
  p.status = 'exchanging';
  const verifier = p.verifier;
  p.verifier = null;
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CALLBACK_URI,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    });
    const r = await fetch(ENDPOINTS.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `xAI answered ${r.status}`);
    const pr = presetById('xai');
    const models = await clientFor(pr.type).listModels({ apiKey: j.access_token, baseUrl: config.baseUrl('xai') || pr.baseUrl, providerId: 'xai' }).then((m) => m.length, () => undefined);
    await config.setProvider('xai', { key: j.access_token, models, via: 'oauth' });
    p.models = models;
    p.status = 'done';
    return page(res, 200, 'Signed in', 'Signed in to xAI. You can close this tab and go back to ORBIX.');
  } catch (e) {
    p.status = 'error';
    p.error = `Sign-in failed: ${e.message}`;
    return page(res, 502, 'Sign-in failed', p.error);
  }
}

export const isXaiAuthUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === 'auth.x.ai';
  } catch {
    return false;
  }
};
