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
  calls.push({ url: u, body: Object.fromEntries(new URLSearchParams(body)), headers: init.headers || {} });
  return answer(u, Object.fromEntries(new URLSearchParams(body)));
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

describe('Sign in with ChatGPT', () => {
  test('the authorize link carries exactly what the Codex CLI sends', async () => {
    const port = await freePort();
    const { url, state } = await pkce.startPkce('openai', { config: fakeConfig(), ports: [port] });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://auth.openai.com/oauth/authorize');
    const q = Object.fromEntries(u.searchParams);
    assert.equal(q.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(q.redirect_uri, `http://127.0.0.1:${port}/auth/callback`);
    assert.equal(q.response_type, 'code');
    assert.equal(q.code_challenge_method, 'S256');
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(q.scope, 'openid profile email offline_access');
    assert.deepEqual([q.id_token_add_organizations, q.codex_cli_simplified_flow, q.originator], ['true', 'true', 'codex_cli_rs']);
    assert.equal(q.state, state);
    assert.equal(pkce.isAuthUrl('openai', url), true);
    assert.equal(pkce.isAuthUrl('openai', 'https://evil.example/oauth/authorize'), false);
    pkce.cancelPkce(state);
  });

  test('a completed sign-in trades the ID token for an API key, checks it and saves it; the server then closes', async () => {
    const port = await freePort();
    const config = fakeConfig();
    calls.length = 0;
    answer = (u, b) => {
      if (u === 'https://auth.openai.com/oauth/token' && b.grant_type === 'authorization_code') return json({ id_token: 'idt', access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      if (u === 'https://auth.openai.com/oauth/token' && b.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') return json({ access_token: 'sk-from-signin' });
      if (/\/models/.test(u)) return json({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] });
      return json({}, 500);
    };
    const { state } = await pkce.startPkce('openai', { config, ports: [port] });
    const r = await get(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`);
    assert.equal(r.status, 200, r.body);
    assert.match(r.body, /Signed in to ChatGPT/);
    const [codeCall, exchange] = calls;
    assert.deepEqual({ ...codeCall.body, code_verifier: !!codeCall.body.code_verifier }, { grant_type: 'authorization_code', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', code: 'the-code', redirect_uri: `http://127.0.0.1:${port}/auth/callback`, code_verifier: true });
    assert.deepEqual(exchange.body, { grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', requested_token: 'openai-api-key', subject_token: 'idt', subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' });
    assert.deepEqual(config.saved, [{ id: 'openai', key: 'sk-from-signin', models: 2, via: 'oauth', refresh: null, expiresAt: null }], 'an API key does not expire, so no refresh token is kept');
    assert.deepEqual(pkce.pkceStatus(state), { status: 'done', error: '', models: 2 });
    const again = await get(`http://127.0.0.1:${port}/auth/callback?code=the-code&state=${state}`).catch(() => ({ status: 'closed' }));
    assert.ok(again.status === 'closed' || again.status === 400, 'the link works once');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await portOpen(port), false, 'the callback server is closed');
  });

  test('an account without an OpenAI Platform organization gets a clear message, not a broken key', async () => {
    const port = await freePort();
    const config = fakeConfig();
    answer = (u, b) => (b.grant_type === 'authorization_code' ? json({ id_token: 'idt', access_token: 'at' }) : json({ error: 'invalid_request', error_description: 'no organization' }, 400));
    const { state } = await pkce.startPkce('openai', { config, ports: [port] });
    const r = await get(`http://127.0.0.1:${port}/auth/callback?code=c&state=${state}`);
    assert.equal(r.status, 502);
    assert.match(pkce.pkceStatus(state).error, /did not create an API key.*no organization.*OpenAI Platform organization/s);
    assert.equal(config.saved.length, 0);
  });
});

describe('the callback server', () => {
  test('a busy port is reported at once, before the browser opens', async () => {
    const port = await freePort();
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise((r) => blocker.on('listening', r));
    try {
      await assert.rejects(() => pkce.startPkce('xai', { config: fakeConfig(), ports: [port] }), /in use/);
    } finally {
      blocker.close();
    }
  });

  test('the next port in the list is used when the first is busy', async () => {
    const [busy, spare] = [await freePort(), await freePort()];
    const blocker = net.createServer().listen(busy, '127.0.0.1');
    await new Promise((r) => blocker.on('listening', r));
    try {
      const { url, state } = await pkce.startPkce('openai', { config: fakeConfig(), ports: [busy, spare] });
      assert.equal(new URL(url).searchParams.get('redirect_uri'), `http://127.0.0.1:${spare}/auth/callback`);
      pkce.cancelPkce(state);
    } finally {
      blocker.close();
    }
  });

  test('unknown or forged states, other paths and a cancelled sign-in are refused', async () => {
    const port = await freePort();
    const { state } = await pkce.startPkce('xai', { config: fakeConfig(), ports: [port] });
    assert.equal((await get(`http://127.0.0.1:${port}/callback?code=x&state=${'A'.repeat(43)}`)).status, 404);
    assert.equal((await get(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
    assert.equal((await get(`http://127.0.0.1:${port}/elsewhere?code=x&state=${state}`)).status, 404);
    const denied = await get(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`);
    assert.equal(denied.status, 400);
    assert.equal(pkce.pkceStatus(state).status, 'error');
    assert.match(pkce.pkceStatus(state).error, /access_denied/);
  });
});

describe('Sign in with xAI', () => {
  test('keeps the refresh token and expiry, and refreshes with the same client', async () => {
    const port = await freePort();
    const config = fakeConfig();
    calls.length = 0;
    answer = (u, b) => {
      if (u === 'https://auth.x.ai/oauth2/token' && b.grant_type === 'authorization_code') return json({ access_token: 'xai-at', refresh_token: 'xai-rt', expires_in: 1800 });
      if (u === 'https://auth.x.ai/oauth2/token' && b.grant_type === 'refresh_token') return json({ access_token: 'xai-at-2', expires_in: 1800 });
      if (/\/models/.test(u)) return json({ data: [{ id: 'grok-a' }] });
      return json({}, 500);
    };
    const { url, state } = await pkce.startPkce('xai', { config, ports: [port] });
    assert.equal(new URL(url).searchParams.get('plan'), 'generic');
    assert.ok(new URL(url).searchParams.get('nonce'));
    const t0 = Date.now();
    assert.equal((await get(`http://127.0.0.1:${port}/callback?code=c&state=${state}`)).status, 200);
    const s = config.saved[0];
    assert.equal(s.key, 'xai-at');
    assert.equal(s.refresh, 'xai-rt');
    assert.ok(s.expiresAt >= t0 + 1790 * 1000 && s.expiresAt <= Date.now() + 1800 * 1000);
    const fresh = await pkce.refreshSignIn('xai', 'xai-rt');
    assert.equal(fresh.key, 'xai-at-2');
    assert.equal(fresh.refresh, 'xai-rt', 'the old refresh token is kept when none is returned');
    assert.deepEqual(calls.at(-1).body, { grant_type: 'refresh_token', refresh_token: 'xai-rt', client_id: 'b1a00492-073a-47ea-816f-4c329264a828' });
    await assert.rejects(() => pkce.refreshSignIn('openai', 'x'), /do not refresh/);
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
