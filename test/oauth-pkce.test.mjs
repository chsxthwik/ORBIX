// Sign in with ChatGPT and with xAI: the authorize link, the callback server, the token exchanges, refresh, and
// what happens when a port is busy, a link is reused or the provider says no. Providers are mocked; nothing leaves
// this machine.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-pkce-test-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });

const realFetch = globalThis.fetch;
const calls = [];
let answer = () => new Response('{}', { status: 500 });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const body = typeof init.body === 'string' ? init.body : '';
  const fields = body.startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
  calls.push({ url: u, body: fields, json: body.startsWith('{') ? JSON.parse(body) : null, headers: init.headers || {} });
  return answer(u, fields);
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const pkce = await import('../src/engine/oauth-pkce.mjs');

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const get = (u) => new Promise((resolve, reject) => http.get(u, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
const fakeConfig = () => {
  const saved = [];
  return { saved, baseUrl: () => '', setProvider: async (id, v) => saved.push({ id, ...v }) };
};
const portOpen = (port) => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => (c.destroy(), resolve(true))); c.on('error', () => resolve(false)); });

after(() => {
  pkce.closeAll();
  globalThis.fetch = realFetch;
});

// A JWT the way OpenAI shapes it; only the claims matter here (nothing verifies the signature).
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const AUTH = 'https://api.openai.com/auth';

describe('Sign in with ChatGPT', () => {
  test('the authorize link carries exactly what the Codex CLI sends', async () => {
    const port = await freePort();
    const { url, state } = await pkce.startPkce('chatgpt', { config: fakeConfig(), ports: [port] });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://auth.openai.com/oauth/authorize');
    const q = Object.fromEntries(u.searchParams);
    assert.equal(q.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(q.redirect_uri, `http://localhost:${port}/auth/callback`, 'the redirect Codex is registered with');
    assert.equal(q.response_type, 'code');
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.scope, 'openid profile email offline_access');
    assert.deepEqual([q.id_token_add_organizations, q.codex_cli_simplified_flow, q.originator], ['true', 'true', 'codex_cli_rs']);
    assert.equal(q.state, state);
    assert.equal(pkce.isAuthUrl('chatgpt', url), true);
    assert.equal(pkce.isAuthUrl('chatgpt', 'https://evil.example/oauth/authorize'), false);
    pkce.cancelPkce(state);
  });

  test('an account with a plan but no Platform organization signs in: the ChatGPT tokens are kept, no API key is made', async () => {
    const port = await freePort();
    const config = fakeConfig();
    calls.length = 0;
    const exp = Math.floor(Date.now() / 1000) + 10 * 24 * 3600;
    const access = jwt({ exp, [AUTH]: { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' } });
    answer = (u, b) => {
      if (u === 'https://auth.openai.com/oauth/token' && b.grant_type === 'authorization_code') return json({ id_token: jwt({ [AUTH]: { chatgpt_account_id: 'acct-1' } }), access_token: access, refresh_token: 'rt' });
      if (u.startsWith('https://chatgpt.com/backend-api/codex/models')) return json({ models: [{ slug: 'gpt-6-sol', visibility: 'list' }, { slug: 'hidden-one', visibility: 'hide' }] });
      return json({ error: 'unexpected' }, 500);
    };
    const { state } = await pkce.startPkce('chatgpt', { config, ports: [port] });
    const r = await get(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.body, /Signed in to ChatGPT/);
    assert.ok(!calls.some((x) => x.body.grant_type?.includes('token-exchange')), 'no API-key exchange');
    const models = calls.find((x) => x.url.includes('/models'));
    assert.equal(models.headers['chatgpt-account-id'], 'acct-1');
    assert.equal(models.headers.authorization, `Bearer ${access}`);
    assert.deepEqual(config.saved, [{ id: 'chatgpt', key: access, models: 1, via: 'oauth', refresh: 'rt', expiresAt: exp * 1000 }]);
    assert.deepEqual(pkce.pkceStatus(state), { status: 'done', error: '', models: 1 });
    const again = await get(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`).catch(() => ({ status: 'closed' }));
    assert.ok(again.status === 'closed' || again.status === 400, 'the link works once');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await portOpen(port), false, 'the callback server is closed');
  });

  test('an account without a ChatGPT workspace gets a clear message', async () => {
    const port = await freePort();
    const config = fakeConfig();
    answer = () => json({ id_token: jwt({ email: 'x' }), access_token: jwt({}), refresh_token: 'rt' });
    const { state } = await pkce.startPkce('chatgpt', { config, ports: [port] });
    assert.equal((await get(`http://127.0.0.1:${port}/auth/callback?code=c&state=${state}`)).status, 502);
    assert.match(pkce.pkceStatus(state).error, /no ChatGPT workspace/);
    assert.equal(config.saved.length, 0);
  });

  test('renewing uses a JSON body like Codex and keeps the old refresh token when none comes back', async () => {
    calls.length = 0;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    answer = () => json({ access_token: jwt({ exp }) });
    const got = await pkce.refreshSignIn('chatgpt', 'rt-1');
    assert.equal(got.refresh, 'rt-1');
    assert.equal(got.expiresAt, exp * 1000);
    assert.deepEqual(calls.at(-1).json, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'rt-1', scope: 'openid profile email' });
  });
});

describe('the callback server', () => {
  test('a busy port is reported at once, before the browser opens', async () => {
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise((r) => blocker.on('listening', r));
    try {
      await assert.rejects(() => pkce.startPkce('chatgpt', { config: fakeConfig(), ports: [port] }), /in use/);
    } finally {
      blocker.close();
    }
  });

  test('the next port in the list is used when the first is busy', async () => {
    const [busy, spare] = [await freePort(), await freePort()];
    const blocker = net.createServer().listen(busy, '127.0.0.1');
    await new Promise((r) => blocker.on('listening', r));
    try {
      const { url, state } = await pkce.startPkce('chatgpt', { config: fakeConfig(), ports: [busy, spare] });
      assert.equal(new URL(url).searchParams.get('redirect_uri'), `http://localhost:${spare}/auth/callback`);
      pkce.cancelPkce(state);
    } finally {
      blocker.close();
    }
  });

  test('unknown or forged states, other paths and a cancelled sign-in are refused', async () => {
    const port = await freePort();
    const { state } = await pkce.startPkce('chatgpt', { config: fakeConfig(), ports: [port] });
    assert.equal((await get(`http://127.0.0.1:${port}/auth/callback?code=x&state=${'A'.repeat(43)}`)).status, 404);
    assert.equal((await get(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    assert.equal((await get(`http://127.0.0.1:${port}/elsewhere?code=x&state=${state}`)).status, 404);
    const denied = await get(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=${state}`);
    assert.equal(denied.status, 400);
    assert.equal(pkce.pkceStatus(state).status, 'error');
    assert.match(pkce.pkceStatus(state).error, /access_denied/);
  });
});

describe('Finishing from a pasted address', () => {
  test('the address the browser landed on finishes the sign-in once; a foreign or empty address is refused', async () => {
    const port = await freePort();
    const config = fakeConfig();
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, [AUTH]: { chatgpt_account_id: 'acct-9' } });
    answer = (u, b) => {
      if (u === 'https://auth.openai.com/oauth/token' && b.grant_type === 'authorization_code') return json({ access_token: access, refresh_token: 'rt' });
      if (u.includes('/models')) return json({ models: [{ slug: 'gpt-x', visibility: 'list' }] });
      return json({}, 500);
    };
    const { state } = await pkce.startPkce('chatgpt', { config, ports: [port] });
    await assert.rejects(() => pkce.finishFromUrl(state, 'not a url'), /full address/);
    await assert.rejects(() => pkce.finishFromUrl(state, `http://localhost:${port}/auth/callback?code=c&state=${'B'.repeat(43)}`), /different sign-in/);
    await assert.rejects(() => pkce.finishFromUrl(state, `http://localhost:${port}/auth/callback?state=${state}`), /no sign-in code/);
    const r = await pkce.finishFromUrl(state, `http://localhost:${port}/auth/callback?code=the-code&state=${state}`);
    assert.equal(r.models, 1);
    assert.equal(config.saved[0].key, access);
    assert.equal(pkce.pkceStatus(state).status, 'done');
    await assert.rejects(() => pkce.finishFromUrl(state, `http://localhost:${port}/auth/callback?code=the-code&state=${state}`), /no longer waiting/);
  });
});

describe('Sign in with xAI (device code)', () => {
  test('shows a code, waits while it is pending, keeps the refresh token and expiry, and refreshes with the same client', async () => {
    const config = fakeConfig();
    calls.length = 0;
    let polls = 0;
    answer = (u, b) => {
      if (u === 'https://auth.x.ai/oauth2/device/code') return json({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://accounts.x.ai/oauth2/device', verification_uri_complete: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234', expires_in: 1800, interval: 0 });
      if (u === 'https://auth.x.ai/oauth2/token' && b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') return ++polls < 2 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'xai-at', refresh_token: 'xai-rt', expires_in: 1800 });
      if (u === 'https://auth.x.ai/oauth2/token' && b.grant_type === 'refresh_token') return json({ access_token: 'xai-at-2', expires_in: 1800 });
      if (/\/models/.test(u)) return json({ data: [{ id: 'grok-a' }] });
      return json({}, 500);
    };
    const t0 = Date.now();
    const { url, state, userCode } = await pkce.startDevice('xai', { config, minInterval: 20 });
    assert.equal(userCode, 'ABCD-1234');
    assert.equal(pkce.isAuthUrl('xai', url), true);
    assert.deepEqual(calls[0].body, { client_id: 'b1a00492-073a-47ea-816f-4c329264a828', scope: 'openid profile email offline_access grok-cli:access api:access' });
    assert.equal(pkce.pkceStatus(state).userCode, 'ABCD-1234');
    for (let i = 0; i < 100 && pkce.pkceStatus(state).status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pkce.pkceStatus(state).status, 'done');
    assert.equal(polls, 2, 'kept asking while the code was pending');
    const s = config.saved[0];
    assert.equal(s.key, 'xai-at');
    assert.equal(s.refresh, 'xai-rt');
    assert.ok(s.expiresAt >= t0 + 1790 * 1000 && s.expiresAt <= Date.now() + 1800 * 1000);
    const fresh = await pkce.refreshSignIn('xai', 'xai-rt');
    assert.equal(fresh.key, 'xai-at-2');
    assert.equal(fresh.refresh, 'xai-rt', 'the old refresh token is kept when none is returned');
    assert.deepEqual(calls.at(-1).body, { grant_type: 'refresh_token', refresh_token: 'xai-rt', client_id: 'b1a00492-073a-47ea-816f-4c329264a828' });
    await assert.rejects(() => pkce.refreshSignIn('openrouter', 'x'), /do not refresh|Unknown|sign-ins/);
  });

  test('a declined code ends the sign-in with a clear message; cancelling stops the polling', async () => {
    let polls = 0;
    answer = (u) => {
      if (u.endsWith('/device/code')) return json({ device_code: 'd', user_code: 'XY', verification_uri: 'https://accounts.x.ai/oauth2/device', interval: 0 });
      polls++;
      return json({ error: polls > 1 ? 'access_denied' : 'authorization_pending' }, 400);
    };
    const a = await pkce.startDevice('xai', { config: fakeConfig(), minInterval: 20 });
    for (let i = 0; i < 100 && pkce.pkceStatus(a.state).status === 'pending'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pkce.pkceStatus(a.state).status, 'error');
    assert.match(pkce.pkceStatus(a.state).error, /declined/);
    polls = -1000;
    const b = await pkce.startDevice('xai', { config: fakeConfig(), minInterval: 20 });
    pkce.cancelPkce(b.state);
    const before = polls;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(polls - before <= 1, 'no polling after cancel');
    await assert.rejects(() => pkce.startPkce('xai', { config: fakeConfig() }), /Unknown sign-in/);
  });

  test('EngineConfig refreshes an expiring sign-in once, and a pasted key clears it', { skip: process.platform !== 'win32' && 'DPAPI is Windows-only', timeout: 60000 }, async () => {
    const { EngineConfig } = await import('../src/engine/store.mjs');
    const dir = path.join(TMP, 'cfg');
    fs.mkdirSync(dir, { recursive: true });
    const cfg = new EngineConfig(dir);
    answer = (u, b) => (b.grant_type === 'refresh_token' ? json({ access_token: 'xai-new', refresh_token: 'rt-2', expires_in: 3600 }) : json({}, 500));
    await cfg.setProvider('xai', { key: 'xai-old', via: 'oauth', refresh: 'rt-1', expiresAt: Date.now() + 60 * 1000 });
    calls.length = 0;
    const [a, b] = await Promise.all([cfg.getKey('xai'), cfg.getKey('xai')]);
    assert.deepEqual([a, b], ['xai-new', 'xai-new']);
    assert.equal(calls.filter((c) => c.body.grant_type === 'refresh_token').length, 1, 'one refresh for both callers');
    assert.ok(cfg.data.providers.xai.expiresAt > Date.now() + 3500 * 1000);
    assert.equal(await cfg.getKey('xai'), 'xai-new', 'no refresh while the token is fresh');
    assert.equal(calls.length, 1);
    await cfg.setProvider('xai', { key: 'xai-pasted' });
    assert.equal(cfg.data.providers.xai.refresh, undefined);
    assert.equal(cfg.data.providers.xai.via, 'key');
    // a refresh the provider refuses is reported to the UI
    await cfg.setProvider('xai', { key: 'xai-old', via: 'oauth', refresh: 'rt-x', expiresAt: Date.now() });
    answer = () => json({ error: 'invalid_grant' }, 400);
    assert.equal(await cfg.getKey('xai'), 'xai-old');
    assert.match(cfg.publicView().providers.find((p) => p.id === 'xai').signInError, /invalid_grant/);
  });
});

describe('Sign in with OpenCode', () => {
  test('device code with JSON bodies, the first organization when none was chosen, and rotating refresh', async () => {
    const config = fakeConfig();
    calls.length = 0;
    let polls = 0;
    answer = (u, b) => {
      if (u === 'https://opencode.ai/console/auth/device/code') return json({ device_code: 'dc', user_code: 'WXYZ-9876', verification_uri_complete: 'https://opencode.ai/console/device?code=WXYZ-9876', expires_in: 900, interval: 0 });
      if (u === 'https://opencode.ai/console/auth/device/token' && b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') return ++polls < 2 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'oc-at', refresh_token: 'oc-rt', expires_in: 3600 });
      if (u === 'https://opencode.ai/console/api/orgs') return json([{ id: 'org-z', name: 'Zeta' }, { id: 'org-a', name: 'Acme' }]);
      if (u === 'https://opencode.ai/console/auth/device/token' && b.grant_type === 'refresh_token') return json({ access_token: 'oc-at-2', refresh_token: 'oc-rt-2', expires_in: 3600 });
      if (u.endsWith('/chat/completions')) return json({ error: { message: 'model is required' } }, 400);
      if (u.endsWith('/models')) return json({ data: [{ id: 'claude-haiku-5-5', type: 'chat', cost: { text: { input: { price: 0.1 }, output: { price: 0.5 } } } }, { id: 'big-pickle', type: 'chat', cost: { text: { input: { price: 0 }, output: { price: 0 } } } }, { id: 'glm-5.3-flash-free', type: 'chat' }] });
      return json({}, 500);
    };
    const { url, state, userCode } = await pkce.startDevice('opencode', { config, minInterval: 20 });
    assert.equal(userCode, 'WXYZ-9876');
    assert.equal(pkce.isAuthUrl('opencode', url), true);
    assert.deepEqual(calls[0].json, { client_id: 'opencode-cli', supports_org_scope: true }, 'JSON, no scope');
    for (let i = 0; i < 100 && pkce.pkceStatus(state).status !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pkce.pkceStatus(state).status, 'done', pkce.pkceStatus(state).error);
    assert.equal(pkce.pkceStatus(state).models, 1, 'free models are left out: OpenCode refuses them to other clients');
    const s = config.saved[0];
    assert.deepEqual([s.key, s.refresh, s.orgId], ['oc-at', 'oc-rt', 'org-a']);
    const models = calls.find((x) => x.url.endsWith('/models'));
    assert.equal(models.headers['x-org-id'], 'org-a');
    assert.match(models.headers['user-agent'], /^orbix\//);
    const fresh = await pkce.refreshSignIn('opencode', 'oc-rt');
    assert.deepEqual([fresh.key, fresh.refresh], ['oc-at-2', 'oc-rt-2']);
    assert.deepEqual(calls.at(-1).json, { grant_type: 'refresh_token', refresh_token: 'oc-rt', client_id: 'opencode-cli' });
  });

  test('a revoked sign-in says to sign in again; a code page on another site is refused', async () => {
    answer = () => json({ error: 'invalid_grant' }, 400);
    await assert.rejects(() => pkce.refreshSignIn('opencode', 'old'), /signed out\. Sign in with OpenCode again/);
    answer = (u) => (u.endsWith('/device/code') ? json({ device_code: 'd', user_code: 'C', verification_uri_complete: 'https://evil.example/device' }) : json({}, 500));
    await assert.rejects(() => pkce.startDevice('opencode', { config: fakeConfig(), minInterval: 20 }), /unexpected site/);
  });

  test('a rejected key is reported before the model list is read', async () => {
    const { clientFor } = await import('../src/engine/providers.mjs');
    answer = (u) => (u.endsWith('/chat/completions') ? json({ error: { message: 'Invalid API key' } }, 401) : json({ data: [] }));
    await assert.rejects(() => clientFor('openai').listModels({ apiKey: 'oc_sk_bad', baseUrl: 'https://opencode.ai/inference/openai/v1', providerId: 'opencode' }), /401|rejected|Invalid/i);
  });
});
