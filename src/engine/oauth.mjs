// "Sign in with OpenRouter": OpenRouter's official PKCE flow for third-party apps
// (https://openrouter.ai/docs/use-cases/oauth-pkce). The browser comes back to this local server with a
// one-time code; we exchange it for a normal API key and store it encrypted like a pasted key.
import crypto from 'node:crypto';
import { clientFor, presetById } from './providers.mjs';
import { escapeHtml as esc } from '../util.mjs';

const ENDPOINTS = { auth: 'https://openrouter.ai/auth', exchange: 'https://openrouter.ai/api/v1/auth/keys' };
export const CALLBACK_PATH = '/oauth/openrouter/callback';
const TTL = 10 * 60 * 1000;
const pending = new Map(); // state -> {verifier, created, status, error, models}
const STATE_RE = /^[A-Za-z0-9_-]{32}$/; // what startOpenRouter() issues (24 random bytes, base64url)
const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function prune() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.created > 2 * TTL) pending.delete(k);
}

/** Start a sign-in. Returns the URL to open in the user's browser and the state to poll with. */
export function startOpenRouter({ port }) {
  prune();
  const live = [...pending.values()].filter((p) => p.status === 'pending');
  if (live.length >= 5) for (const [k, v] of pending) if (v.status === 'pending') pending.delete(k); // keep it small
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  pending.set(state, { verifier, created: Date.now(), status: 'pending', error: '' });
  const callback = `http://localhost:${port}${CALLBACK_PATH}/${state}`;
  const u = new URL(ENDPOINTS.auth);
  u.searchParams.set('callback_url', callback);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('key_label', 'ORBIX');
  return { url: u.toString(), state };
}

/** Where a sign-in stands: pending | done | error | expired | unknown. */
export function oauthStatus(state) {
  const p = pending.get(String(state || ''));
  if (!p) return { status: 'unknown' };
  if (p.status === 'pending' && Date.now() - p.created > TTL) return { status: 'expired', error: 'The sign-in took longer than 10 minutes. Try again.' };
  return { status: p.status, error: p.error || '', models: p.models };
}

export function cancelOAuth(state) {
  pending.delete(String(state || ''));
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

/**
 * Handle GET /oauth/openrouter/callback/<state>?code=... (no token cookie: the browser has none).
 * The state must be one we issued, unused, and under 10 minutes old.
 * The key is stored encrypted through `config` (EngineConfig), exactly like a pasted key.
 */
export async function handleCallback(url, res, config) {
  const fromPath = url.pathname.startsWith(CALLBACK_PATH + '/') ? url.pathname.slice(CALLBACK_PATH.length + 1) : '';
  const state = fromPath || url.searchParams.get('state') || '';
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
    p.error = 'Sign-in was cancelled.';
    return page(res, 400, 'Sign-in cancelled', 'No key was created. You can close this tab.');
  }
  p.status = 'exchanging'; // one-time: a second hit with the same state is refused
  const verifier = p.verifier;
  p.verifier = null; // used once; not kept in memory afterwards
  try {
    const r = await fetch(ENDPOINTS.exchange, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || typeof j.key !== 'string' || !j.key) throw new Error(j.error?.message || j.message || `OpenRouter answered ${r.status}`);
    const pr = presetById('openrouter');
    const models = await clientFor(pr.type).listModels({ apiKey: j.key, baseUrl: config.baseUrl('openrouter') || pr.baseUrl, providerId: 'openrouter' }).then((m) => m.length, () => undefined);
    await config.setProvider('openrouter', { key: j.key, models, via: 'oauth' });
    p.models = models;
    p.status = 'done';
    return page(res, 200, 'Signed in', 'Signed in to OpenRouter. You can close this tab and go back to ORBIX.');
  } catch (e) {
    p.status = 'error';
    p.error = `Sign-in failed: ${e.message}`;
    return page(res, 502, 'Sign-in failed', p.error);
  }
}

/** Only OpenRouter's own sign-in page may be opened by the sign-in route. */
export const isOpenRouterAuthUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname === 'openrouter.ai' && x.pathname === '/auth';
  } catch {
    return false;
  }
};
