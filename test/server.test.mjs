// Real HTTP tests for the local server (src/server.mjs): auth, DNS-rebinding/CSRF guards, static files,
// workspace/fs/session APIs and shutdown. Starts the AppServer in-process on port 0 with ORBIX_DATA in a temp dir.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-test-'));
const DATA = path.join(TMP, 'data');
process.env.ORBIX_DATA = DATA; // before anything imports src/store.mjs
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (f) => pathToFileURL(path.join(ROOT, 'src', f)).href;

const { Store } = await import(SRC('store.mjs'));
const { AppServer, VERSION, trackOpenUi } = await import(SRC('server.mjs'));

describe('open questions survive a window reload', () => {
  const ask = (id, method = 'select') => ({ type: 'extension_ui_request', id, method, title: 'Run this command?', options: ['Allow once', 'Deny'] });
  test('questions are kept until answered, cancelled or the turn ends', () => {
    const open = new Map();
    trackOpenUi(open, ask('a'));
    trackOpenUi(open, ask('b'));
    // The agent asks only with select; other methods are notifications (or unknown) and are never kept.
    trackOpenUi(open, ask('i', 'input'));
    trackOpenUi(open, { type: 'extension_ui_request', id: 'n', method: 'notify', message: 'hi' });
    trackOpenUi(open, { type: 'extension_ui_request', id: 's', method: 'setStatus', statusKey: 'x' });
    assert.deepEqual([...open.keys()], ['a', 'b'], 'only questions that wait for an answer');
    trackOpenUi(open, { type: 'extension_ui_request', id: 'c', method: 'cancel', targetId: 'a' });
    assert.deepEqual([...open.keys()], ['b']);
    trackOpenUi(open, { type: 'agent_end', isTerminal: false });
    assert.equal(open.size, 1, 'a non-terminal agent_end keeps them');
    trackOpenUi(open, { type: 'agent_end' });
    assert.equal(open.size, 0);
  });
});

const TOKEN = 'a'.repeat(48);
const COOKIE = `orbix=${TOKEN}`;

/** Raw HTTP request (no URL normalisation, any Host header, no keep-alive). */
function raw(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const hdrs = { host: `127.0.0.1:${port}`, ...headers };
    if (data !== undefined) hdrs['content-length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: hdrs, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf,
          text: buf.toString('utf8'),
          get json() {
            return JSON.parse(buf.toString('utf8'));
          },
        });
      });
    });
    r.on('error', reject);
    r.end(data);
  });
}

function makeStore() {
  const store = new Store();
  store.data.backend = { kind: 'native', distro: '' }; // never touch wsl.exe from tests
  store.data.backendChosen = true;
  return store;
}

let h; // main server (real web/ and assets/)
let port;
let store;
let h2; // server over temp web/assets roots
let port2;
const webRoot2 = path.join(TMP, 'site', 'web');
const assetsRoot2 = path.join(TMP, 'site', 'assets');

/** Authenticated request helper for the main server. */
const api = (method, p, { headers = {}, body } = {}) =>
  raw(port, method, p, { headers: { cookie: COOKIE, ...(method === 'GET' ? {} : { 'x-orbix': '1' }), ...headers }, body });

before(async () => {
  store = makeStore();
  h = new AppServer({ store, token: TOKEN });
  port = await h.listen(0);

  fs.mkdirSync(path.join(webRoot2, 'sub'), { recursive: true });
  fs.mkdirSync(assetsRoot2, { recursive: true });
  fs.mkdirSync(path.join(TMP, 'site', 'web-private'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'site', 'web-private', 'x.txt'), 'PRIVATE-SIBLING');
  fs.writeFileSync(path.join(TMP, 'site', 'secret.txt'), 'SECRET-OUTSIDE');
  for (const [name, content] of [
    ['index.html', '<!doctype html><title>t</title>'],
    ['a.js', 'export const a=1;'],
    ['b.mjs', 'export const b=2;'],
    ['up.JS', 'export const c=3;'],
    ['s.css', 'body{}'],
    ['f.woff2', Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])],
    ['p.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['i.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['d.json', '{"x":1}'],
    ['m.webmanifest', '{}'],
    ['blob.xyz', 'bin'],
    [path.join('sub', 'n.txt'), 'nested'],
  ]) fs.writeFileSync(path.join(webRoot2, name), content);
  fs.writeFileSync(path.join(assetsRoot2, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  h2 = new AppServer({ store: makeStore(), token: TOKEN, webRoot: webRoot2, assetsRoot: assetsRoot2 });
  port2 = await h2.listen(0);
});

after(async () => {
  await h?.shutdown();
  await h2?.shutdown();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('authentication', () => {
  test('/api/ping is public and reports only the app and version (no pid)', async () => {
    const r = await raw(port, 'GET', '/api/ping');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['app', 'version']);
    assert.equal(r.json.app, 'orbix');
    assert.equal(r.json.version, VERSION);
  });

  test('API and static requests without the cookie get 401 (including unknown endpoints)', async () => {
    const cases = [
      ['GET', '/api/state'],
      ['GET', '/api/fs/list?path=' + encodeURIComponent(TMP)],
      ['GET', '/api/events'],
      ['GET', '/api/nope'],
      ['POST', '/api/sessions/delete'],
      ['POST', '/api/quit'],
      ['GET', '/'],
      ['GET', '/index.html'],
    ];
    for (const [m, p] of cases) {
      const r = await raw(port, m, p, { headers: m === 'POST' ? { 'x-orbix': '1' } : {}, body: m === 'POST' ? {} : undefined });
      assert.equal(r.status, 401, `${m} ${p}`);
      assert.doesNotMatch(r.text, /"ok":\s*true/);
    }
  });

  test('wrong, truncated, extended or misnamed cookies are rejected', async () => {
    const bad = [
      'orbix=wrong',
      `orbix=${TOKEN.slice(0, -1)}`,
      `orbix=${TOKEN}x`,
      'orbix=',
      `xorbix=${TOKEN}`,
      `orbix2=${TOKEN}`,
      `session=${TOKEN}`,
    ];
    for (const cookie of bad) {
      const r = await raw(port, 'GET', '/api/state', { headers: { cookie } });
      assert.equal(r.status, 401, cookie);
    }
  });

  test('token in the query string or an Authorization header does not authenticate API calls', async () => {
    assert.equal((await raw(port, 'GET', `/api/state?t=${TOKEN}`)).status, 401);
    assert.equal((await raw(port, 'GET', '/api/state', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401);
  });

  test('a valid cookie works, also among other cookies', async () => {
    for (const cookie of [COOKIE, `a=b; ${COOKIE}`, `a=b; ${COOKIE}; c=d`, `a=b;${COOKIE}`]) {
      const r = await raw(port, 'GET', '/api/state', { headers: { cookie } });
      assert.equal(r.status, 200, cookie);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.app.version, VERSION);
    }
  });

  test('bootstrap: /?t=<token> redirects to / and sets an HttpOnly SameSite=Strict cookie that then authenticates', async () => {
    const r = await raw(port, 'GET', `/?t=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const setCookie = [].concat(r.headers['set-cookie']).join('\n');
    const parts = setCookie.split(';').map((s) => s.trim());
    assert.equal(parts[0], `orbix=${TOKEN}`);
    assert.ok(parts.includes('HttpOnly'), setCookie);
    assert.ok(parts.includes('SameSite=Strict'), setCookie);
    assert.ok(parts.includes('Path=/'), setCookie);
    assert.ok(!parts.some((p) => /^Domain=/i.test(p)), 'must be host-only');
    assert.equal(r.headers['cache-control'], 'no-store');

    // Use the cookie exactly as a browser would send it back.
    const cookie = parts[0];
    const state = await raw(port, 'GET', '/api/state', { headers: { cookie } });
    assert.equal(state.status, 200);
    const page = await raw(port, 'GET', '/', { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
  });

  test('bootstrap with a wrong or empty token sets no cookie', async () => {
    for (const t of ['nope', TOKEN.slice(0, -1), TOKEN + 'x', '']) {
      const r = await raw(port, 'GET', `/?t=${t}`);
      assert.ok(!r.headers['set-cookie'], `t=${t}`);
      assert.ok(r.status === 403 || r.status === 401, `t=${t} -> ${r.status}`);
    }
  });

  test('the token bootstrap only works on "/" (not on other paths)', async () => {
    const r = await raw(port, 'GET', `/index.html?t=${TOKEN}`);
    assert.equal(r.status, 401);
    assert.ok(!r.headers['set-cookie']);
  });
});

describe('DNS-rebinding guard (Host header)', () => {
  const bad = (p) => [
    'evil.com',
    `evil.com:${p}`,
    '127.0.0.1',
    'localhost',
    `127.0.0.1.evil.com:${p}`,
    `localhost.evil.com:${p}`,
    `localhost:${p}.evil.com`,
    `127.0.0.1:${p + 1}`,
    `[::1]:${p}`,
    `0.0.0.0:${p}`,
  ];

  test('requests with a foreign Host are refused with 403 even with a valid cookie', async () => {
    for (const host of bad(port)) {
      const r = await raw(port, 'GET', '/api/state', { headers: { host, cookie: COOKIE } });
      assert.equal(r.status, 403, `Host: "${host}"`);
      assert.equal(r.json.ok, false);
      assert.doesNotMatch(r.text, /workspaces/);
    }
  });

  test('/api/ping, bootstrap and static files are guarded too', async () => {
    for (const p of ['/api/ping', `/?t=${TOKEN}`, '/', '/index.html']) {
      const r = await raw(port, 'GET', p, { headers: { host: 'evil.com', cookie: COOKIE } });
      assert.equal(r.status, 403, p);
      assert.ok(!r.headers['set-cookie'], p);
    }
  });

  test('localhost:<port> and a differently-cased Host are accepted', async () => {
    for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
      const r = await raw(port, 'GET', '/api/state', { headers: { host, cookie: COOKIE } });
      assert.equal(r.status, 200, host);
    }
  });
});

describe('CSRF guard on mutating API calls', () => {
  const body = { id: 'does-not-exist' };
  const post = (headers) => raw(port, 'POST', '/api/workspaces/remove', { headers: { cookie: COOKIE, ...headers }, body });

  test('POST without the x-orbix header is blocked', async () => {
    const r = await post({});
    assert.equal(r.status, 403);
    assert.match(r.json.error, /cross-site/i);
  });

  test('the header must be exactly "1"', async () => {
    for (const v of ['0', 'true', '', '11', ' ']) assert.equal((await post({ 'x-orbix': v })).status, 403, JSON.stringify(v));
  });

  test('foreign Origin is blocked even with the header', async () => {
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1.evil.example:${port}`, `https://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const r = await post({ 'x-orbix': '1', origin });
      assert.equal(r.status, 403, origin);
    }
  });

  test('same-origin Origin plus header is accepted; header alone (no Origin) is accepted', async () => {
    const withOrigin = await post({ 'x-orbix': '1', origin: `http://127.0.0.1:${port}` });
    assert.equal(withOrigin.status, 200);
    assert.equal(withOrigin.json.ok, true);
    assert.equal((await post({ 'x-orbix': '1' })).status, 200);
  });

  test('a GET with a foreign Origin is blocked too (a page on another local port shares our cookie)', async () => {
    const get = (origin) => raw(port, 'GET', '/api/state', { headers: { cookie: COOKIE, ...(origin ? { origin } : {}) } });
    assert.equal((await get(`http://localhost:${port + 1}`)).status, 403);
    assert.equal((await get('http://evil.example')).status, 403);
    assert.equal((await get(`http://127.0.0.1:${port}`)).status, 200);
    assert.equal((await get()).status, 200);
  });

  test('matching Origin without the header is still blocked', async () => {
    assert.equal((await post({ origin: `http://127.0.0.1:${port}` })).status, 403);
  });

  test('other mutating methods (PUT/DELETE/PATCH) need the header too', async () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const r = await raw(port, m, '/api/workspaces/remove', { headers: { cookie: COOKIE }, body });
      assert.equal(r.status, 403, m);
    }
  });

  test('the CSRF check does not bypass authentication', async () => {
    const r = await raw(port, 'POST', '/api/workspaces/remove', { headers: { 'x-orbix': '1', origin: `http://127.0.0.1:${port}` }, body });
    assert.equal(r.status, 401);
  });

  test('GETs and static files from another site or another local port (no Origin, Sec-Fetch-Site) are blocked', async () => {
    for (const site of ['cross-site', 'same-site']) {
      for (const p of ['/api/state', '/api/fs/list?path=' + encodeURIComponent(TMP), '/', '/index.html']) {
        const r = await raw(port, 'GET', p, { headers: { cookie: COOKIE, 'sec-fetch-site': site } });
        assert.equal(r.status, 403, `${site} ${p}`);
      }
    }
    for (const site of ['same-origin', 'none']) assert.equal((await raw(port, 'GET', '/api/state', { headers: { cookie: COOKIE, 'sec-fetch-site': site } })).status, 200, site);
    assert.equal((await raw(port, 'GET', '/api/ping', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200, 'ping stays public');
  });
});

describe('request bodies', () => {
  test('a "__proto__" key in a body cannot change the prototype of stored settings', async () => {
    const r = await api('POST', '/api/prefs', { body: '{"ui":{"__proto__":{"polluted":"yes"},"fontSize":15}}' });
    assert.equal(r.status, 200);
    assert.equal(Object.getPrototypeOf(store.data.ui), Object.prototype);
    assert.equal(store.data.ui.polluted, undefined);
    assert.equal(store.data.ui.fontSize, 15);
  });

  test('the event stream carries the protective headers too', async () => {
    const headers = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, cookie: COOKIE }, agent: false }, (res) => {
        resolve(res.headers);
        res.destroy();
      });
      rq.on('error', reject);
      rq.end();
    });
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  });
});

describe('API plumbing', () => {
  test('unknown endpoints and wrong methods give 404 JSON', async () => {
    const a = await api('GET', '/api/does/not/exist');
    assert.equal(a.status, 404);
    assert.equal(a.json.ok, false);
    assert.equal((await api('GET', '/api/workspaces/remove')).status, 404);
    assert.equal((await api('POST', '/api/state', { body: {} })).status, 404);
  });

  test('malformed JSON body gives 400', async () => {
    const r = await api('POST', '/api/workspaces', { body: '{not json' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /json/i);
  });

  test('API responses are JSON, uncacheable and nosniff', async () => {
    const r = await api('GET', '/api/state');
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });

  test('a JSON body that is not an object is a 400, not a server error', async () => {
    const r = await api('POST', '/api/workspaces', { body: 'null' });
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  });
});

describe('static files', () => {
  test('index.html is served at / with the CSP and hardening headers', async () => {
    const r = await api('GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.deepEqual(r.buf, fs.readFileSync(path.join(ROOT, 'web', 'index.html')));
    const csp = r.headers['content-security-policy'];
    const dirs = Object.fromEntries(csp.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
    assert.equal(dirs['default-src'], "'self'");
    assert.equal(dirs['script-src'], "'self'"); // no inline/eval script
    assert.equal(dirs['connect-src'], "'self'");
    assert.equal(dirs['object-src'], "'none'");
    assert.equal(dirs['frame-ancestors'], "'none'");
    assert.equal(dirs['base-uri'], "'none'");
    assert.equal(dirs['form-action'], "'none'");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-cache');
  });

  test('real app files have the right content types', async () => {
    const jsFile = fs.readdirSync(path.join(ROOT, 'web', 'js')).find((f) => f.endsWith('.js'));
    const expect = [
      [`/js/${jsFile}`, /^text\/javascript/],
      ['/css/app.css', /^text\/css/],
      ['/fonts/ibm-plex-sans-latin-wght-normal.woff2', /^font\/woff2$/],
      ['/assets/icon.png', /^image\/png$/],
      ['/assets/icon.ico', /^image\/x-icon$/],
    ];
    for (const [p, re] of expect) {
      const r = await api('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], re, p);
      assert.ok(r.headers['content-security-policy'], p);
      assert.equal(Number(r.headers['content-length']), r.buf.length, p);
    }
  });

  test('content type mapping over a controlled web root (incl. extension case and unknown types)', async () => {
    const get = (p) => raw(port2, 'GET', p, { headers: { cookie: COOKIE } });
    const expect = {
      '/a.js': 'text/javascript; charset=utf-8',
      '/b.mjs': 'text/javascript; charset=utf-8',
      '/up.JS': 'text/javascript; charset=utf-8',
      '/s.css': 'text/css; charset=utf-8',
      '/f.woff2': 'font/woff2',
      '/p.png': 'image/png',
      '/i.svg': 'image/svg+xml',
      '/d.json': 'application/json; charset=utf-8',
      '/m.webmanifest': 'application/manifest+json',
      '/blob.xyz': 'application/octet-stream',
      '/assets/logo.png': 'image/png',
    };
    for (const [p, type] of Object.entries(expect)) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
    }
    // bytes are served unmodified
    assert.deepEqual((await get('/f.woff2')).buf, Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]));
    assert.equal((await get('/sub/n.txt')).headers['content-type'], 'application/octet-stream');
  });

  test('/assets/ is mapped to the assets root, not the web root', async () => {
    const r = await raw(port2, 'GET', '/assets/index.html', { headers: { cookie: COOKIE } });
    assert.equal(r.status, 404); // index.html exists in web/ but not in assets/
    assert.equal((await raw(port2, 'GET', '/logo.png', { headers: { cookie: COOKIE } })).status, 404);
  });

  test('missing files and directories give 404 JSON', async () => {
    for (const p of ['/nope.js', '/sub', '/sub/', '/assets/', '/assets']) {
      const r = await raw(port2, 'GET', p, { headers: { cookie: COOKIE } });
      assert.equal(r.status, 404, p);
      assert.match(r.headers['content-type'], /json/);
    }
  });

  test('ETag: 304 on If-None-Match, 200 on mismatch, new ETag after the file changes', async () => {
    const hdr = { cookie: COOKIE };
    const first = await raw(port2, 'GET', '/a.js', { headers: hdr });
    const etag = first.headers.etag;
    assert.match(etag, /^W\/".+"$/);

    const hit = await raw(port2, 'GET', '/a.js', { headers: { ...hdr, 'if-none-match': etag } });
    assert.equal(hit.status, 304);
    assert.equal(hit.buf.length, 0);
    assert.equal(hit.headers.etag, etag);
    assert.ok(hit.headers['content-security-policy'], '304 keeps the security headers');

    const miss = await raw(port2, 'GET', '/a.js', { headers: { ...hdr, 'if-none-match': 'W/"stale"' } });
    assert.equal(miss.status, 200);
    assert.equal(miss.text, 'export const a=1;');

    fs.writeFileSync(path.join(webRoot2, 'a.js'), 'export const a=12345;');
    const after = await raw(port2, 'GET', '/a.js', { headers: { ...hdr, 'if-none-match': etag } });
    assert.equal(after.status, 200, 'edited file must not be answered with 304');
    assert.equal(after.text, 'export const a=12345;');
    assert.notEqual(after.headers.etag, etag);
  });

  test('ETag differs between files with different content/size', async () => {
    const a = await raw(port2, 'GET', '/s.css', { headers: { cookie: COOKIE } });
    const b = await raw(port2, 'GET', '/d.json', { headers: { cookie: COOKIE } });
    assert.notEqual(a.headers.etag, b.headers.etag);
  });
});

describe('static path traversal', () => {
  const PKG_MARK = '"name": "orbix"';
  const SRC_MARK = 'class AppServer';
  const leaks = (r) => r.text.includes(PKG_MARK) || r.text.includes(SRC_MARK) || r.text.includes('const MIME');

  const attempts = [
    '/../package.json',
    '/../src/server.mjs',
    '/..%2fpackage.json',
    '/..%2Fsrc%2Fserver.mjs',
    '/%2e%2e/package.json',
    '/%2E%2E/src/server.mjs',
    '/%2e%2e%2fpackage.json',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/.%2e/package.json',
    '/..%5cpackage.json',
    '/..%5csrc%5cserver.mjs',
    '/..\\package.json',
    '/..\\src\\server.mjs',
    '/%2e%2e%5cpackage.json',
    '/css/../../package.json',
    '/css/..%2f..%2fsrc/server.mjs',
    '/css/%2e%2e/%2e%2e/src/server.mjs',
    '/fonts/..\\..\\package.json',
    '/assets/../package.json',
    '/assets/../src/server.mjs',
    '/assets/%2e%2e/package.json',
    '/assets/..%2fsrc%2fserver.mjs',
    '/assets/..\\package.json',
    '/assets/%2e%2e/web/index.html', // escapes assets/ even though it lands in web/
    '/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/../../../../../../etc/passwd',
    '/%252e%252e/package.json', // double encoding stays a literal folder name
    '/%252e%252e%252fpackage.json',
    '/C:/Windows/win.ini',
    '/C:%5CWindows%5Cwin.ini',
    '/%5C%5Clocalhost%5CC$%5CWindows%5Cwin.ini',
    '/%c0%ae%c0%ae/package.json', // overlong UTF-8 dot-dot
    '/%2e%2e;/package.json',
    '/....//package.json',
    '/..././package.json',
    '/web/../../package.json',
    '/package.json',
    '/src/server.mjs',
  ];

  test('no encoding of ../ or backslashes reaches files outside web/ and assets/ (real roots)', async () => {
    for (const p of attempts) {
      const r = await api('GET', p);
      assert.ok(r.status >= 400 && r.status < 500, `GET ${p} -> ${r.status}: ${r.text.slice(0, 80)}`);
      assert.ok(!leaks(r), `GET ${p} leaked file contents`);
    }
  });

  test('an encoded NUL byte is a client error, not a 500 that leaks a Node internals message', async () => {
    for (const p of ['/..%00/package.json', '/index.html%00.png', '/%00']) {
      const r = await api('GET', p);
      assert.ok(r.status >= 400 && r.status < 500, `GET ${p} -> ${r.status}: ${r.text.slice(0, 80)}`);
      assert.doesNotMatch(r.text, /must be a string/);
    }
  });

  test('invalid percent-encoding is a clean 400', async () => {
    for (const p of ['/%', '/%zz', '/%e0%a4%a', '/%c0%ae%c0%ae/package.json', '/%ff']) {
      const r = await api('GET', p);
      assert.equal(r.status, 400, p);
    }
  });

  test('sibling folder sharing the root name prefix (web-private) and files above the root are unreachable', async () => {
    for (const p of ['/../web-private/x.txt', '/..%2fweb-private%2fx.txt', '/%2e%2e/web-private/x.txt', '/../secret.txt', '/..%5csecret.txt', '/assets/../secret.txt', '/assets/../../web/index.html']) {
      const r = await raw(port2, 'GET', p, { headers: { cookie: COOKIE } });
      assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /PRIVATE-SIBLING|SECRET-OUTSIDE|<title>t<\/title>/, p);
    }
  });

  test('a legitimate nested path with ".." that stays inside the root still works', async () => {
    const r = await raw(port2, 'GET', '/sub/../a.js', { headers: { cookie: COOKIE } });
    assert.equal(r.status, 200);
  });

  test('traversal attempts need authentication first', async () => {
    const r = await raw(port, 'GET', '/../package.json');
    assert.equal(r.status, 401);
    assert.ok(!leaks(r));
  });
});

describe('workspaces', () => {
  let dir;
  before(() => {
    dir = path.join(TMP, 'ws', 'My Project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'ws', 'file.txt'), 'x');
  });
  const add = (b) => api('POST', '/api/workspaces', { body: b });

  test('empty, whitespace-only and missing path are rejected with 400', async () => {
    for (const b of [{}, { path: '' }, { path: '   ' }, { path: null }]) {
      const r = await add(b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.match(r.json.error, /path required/i);
    }
    assert.equal(store.data.workspaces.length, 0);
  });

  test('non-existent folder and a file path are rejected with 400 and not stored', async () => {
    const missing = await add({ path: path.join(TMP, 'ws', 'does-not-exist') });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /not a folder/i);
    const file = await add({ path: path.join(TMP, 'ws', 'file.txt') });
    assert.equal(file.status, 400);
    assert.match(file.json.error, /not a folder/i);
    const obj = await add({ path: { a: 1 } });
    assert.equal(obj.status, 400);
    assert.equal(store.data.workspaces.length, 0);
  });

  test('adding a folder stores it (name defaults to the folder name) and persists to config.json', async () => {
    const r = await add({ path: dir });
    assert.equal(r.status, 200);
    assert.equal(r.json.workspace.path, dir);
    assert.equal(r.json.workspace.name, 'My Project');
    assert.equal(r.json.workspaces.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    assert.equal(saved.workspaces[0].path, dir);
    const state = await api('GET', '/api/state');
    assert.deepEqual(state.json.workspaces.map((w) => w.path), [dir]);
  });

  test('adding the same path again (also with surrounding whitespace / different case) returns the existing entry', async () => {
    const first = store.data.workspaces[0];
    for (const p of [dir, `  ${dir}  `, dir.toUpperCase().replace(/^([A-Z]):/, (m) => m.toLowerCase())]) {
      // on a case-sensitive FS the upper-cased path does not exist: only check variants that do
      if (!fs.existsSync(p.trim())) continue;
      const r = await add({ path: p });
      assert.equal(r.status, 200);
      assert.equal(r.json.workspace.id, first.id);
      assert.equal(r.json.workspaces.length, 1);
    }
    assert.equal(store.data.workspaces.length, 1);
  });

  test('a custom name is used for a new workspace and a second folder is appended', async () => {
    const other = path.join(TMP, 'ws', 'other');
    fs.mkdirSync(other);
    const r = await add({ path: other, name: 'Custom' });
    assert.equal(r.json.workspace.name, 'Custom');
    assert.equal(r.json.workspaces.length, 2);
  });

  test('remove deletes by id and ignores unknown ids', async () => {
    const [a, b] = store.data.workspaces;
    const r = await api('POST', '/api/workspaces/remove', { body: { id: a.id } });
    assert.deepEqual(r.json.workspaces.map((w) => w.id), [b.id]);
    const again = await api('POST', '/api/workspaces/remove', { body: { id: 'zzz' } });
    assert.equal(again.status, 200);
    assert.equal(again.json.workspaces.length, 1);
  });
});

describe('GET /api/fs/list', () => {
  let dir;
  before(() => {
    dir = path.join(TMP, 'listing');
    fs.mkdirSync(path.join(dir, 'b-dir'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'A-dir'));
    fs.mkdirSync(path.join(dir, 'dir10'));
    fs.mkdirSync(path.join(dir, 'dir2'));
    fs.writeFileSync(path.join(dir, 'z.txt'), 'z');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  });
  const list = (p, extra = '') => api('GET', `/api/fs/list?path=${encodeURIComponent(p)}${extra}`);

  test('lists directories first, then files, each group naturally sorted, with joined paths', async () => {
    const r = await list(dir);
    assert.equal(r.status, 200);
    const l = r.json.listing;
    assert.equal(l.path, dir);
    assert.equal(l.parent, path.dirname(dir));
    assert.deepEqual(l.entries.map((e) => e.name), ['A-dir', 'b-dir', 'dir2', 'dir10', 'a.txt', 'z.txt']);
    assert.deepEqual(l.entries.map((e) => e.dir), [true, true, true, true, false, false]);
    for (const e of l.entries) assert.equal(path.normalize(e.path), path.join(dir, e.name));
  });

  test('dirs=1 returns only folders', async () => {
    const r = await list(dir, '&dirs=1');
    assert.deepEqual(r.json.listing.entries.map((e) => e.name), ['A-dir', 'b-dir', 'dir2', 'dir10']);
  });

  test('a path that does not exist, or is a file, gives 404 with the path in the message', async () => {
    const gone = await list(path.join(dir, 'nope'));
    assert.equal(gone.status, 404);
    assert.match(gone.json.error, /Cannot open/);
    const file = await list(path.join(dir, 'a.txt'));
    assert.equal(file.status, 404);
  });

  test('an empty path lists the roots (no parent)', async () => {
    const r = await api('GET', '/api/fs/list');
    assert.equal(r.status, 200);
    assert.equal(r.json.listing.path, '');
    assert.equal(r.json.listing.parent, null);
    assert.ok(r.json.listing.entries.some((e) => e.kind === 'home'));
  });

  test('an empty folder lists as empty', async () => {
    const empty = path.join(TMP, 'empty-dir');
    fs.mkdirSync(empty);
    assert.deepEqual((await list(empty)).json.listing.entries, []);
  });
});

describe('POST /api/sessions/delete', () => {
  const sessions = path.join(DATA, 'sessions');
  const del = (paths) => api('POST', '/api/sessions/delete', { body: { paths } });
  const mk = (...parts) => {
    const f = path.join(...parts);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{"type":"session"}\n');
    return f;
  };

  test('refuses an empty list, a missing/non-array list and more than 500 entries (deleting nothing)', async () => {
    const keep = mk(sessions, 'proj', 'keep.jsonl');
    for (const body of [{ paths: [] }, {}, { paths: 'x.jsonl' }, { paths: { length: 1 } }, { paths: null }]) {
      const r = await api('POST', '/api/sessions/delete', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.json.error, /nothing to delete/i);
    }
    const tooMany = Array.from({ length: 501 }, (_, i) => path.join(sessions, 'proj', `n${i}.jsonl`));
    tooMany[0] = keep;
    const r = await del(tooMany);
    assert.equal(r.status, 400);
    assert.ok(fs.existsSync(keep), 'nothing may be deleted when the request is rejected');
  });

  test('exactly 500 entries are accepted', async () => {
    const list = Array.from({ length: 500 }, (_, i) => path.join(sessions, 'big', `n${i}.jsonl`));
    const r = await del(list);
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 500);
  });

  test('deletes a session file inside <data>/sessions/<project>/', async () => {
    const f = mk(sessions, 'proj', 'del.jsonl');
    const r = await del([f]);
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1);
    assert.ok(!fs.existsSync(f));
  });

  test('refuses files outside the sessions folders and leaves them untouched', async () => {
    const victims = [
      mk(TMP, 'outside', 'proj', 'v.jsonl'), // right depth, wrong root
      mk(TMP, 'outside2.jsonl'),
      mk(DATA, 'secret.jsonl'), // <data>/ itself
      mk(sessions, 'direct.jsonl'), // <sessions>/file.jsonl (missing project folder level)
      mk(sessions, 'a', 'b', 'deep.jsonl'), // one level too deep
      mk(DATA, 'sessions-evil', 'proj', 'v.jsonl'), // shares the name prefix
      mk(sessions, 'proj', 'notes.txt'), // right place, wrong type
      mk(sessions, 'proj', 'x.jsonl.bak'),
    ];
    const traversal = [
      path.join(sessions, 'proj', '..', '..', 'secret.jsonl'), // resolves to <data>/secret.jsonl
      path.join(sessions, 'proj', '..', '..', '..', 'outside2.jsonl'),
      `${sessions}/proj/../../secret.jsonl`,
      `${sessions}\\proj\\..\\..\\secret.jsonl`,
    ];
    for (const p of [...victims, ...traversal]) {
      const r = await del([p]);
      assert.ok(r.status >= 400, `${p} -> ${r.status} ${r.text}`);
      assert.equal(r.json.ok, false, p);
    }
    for (const v of victims) assert.ok(fs.existsSync(v), `${v} must survive`);
    assert.ok(fs.existsSync(path.join(DATA, 'secret.jsonl')));
    assert.ok(fs.existsSync(path.join(TMP, 'outside2.jsonl')));
  });

  test('non-string entries are refused', async () => {
    for (const bad of [123, null, { a: 1 }, ['x.jsonl']]) {
      const r = await del([bad]);
      assert.ok(r.status >= 400, JSON.stringify(bad));
    }
  });

  test('a rejected path error is reported as a client error (4xx), not a 500', async () => {
    const f = mk(TMP, 'outside3', 'proj', 'v.jsonl');
    const r = await del([f]);
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  });
});

describe('shutdown', () => {
  test('a separate server stops listening after shutdown() and closes open SSE streams', async () => {
    const hx = new AppServer({ store: makeStore(), token: TOKEN });
    const px = await hx.listen(0);
    const events = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: px, path: '/api/events', headers: { host: `127.0.0.1:${px}`, cookie: COOKIE }, agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve(buf)); // only fires if the server ends the stream
        res.on('error', reject);
        setTimeout(() => hx.shutdown(), 100);
      });
      r.on('error', reject);
      r.end();
    });
    assert.match(events, /"g":"hello"/);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(raw(px, 'GET', '/api/ping'), (e) => e.code === 'ECONNREFUSED');
  });

  test('a process that started the server, served requests (incl. an SSE stream) and called shutdown() exits by itself', async () => {
    const dataDir = path.join(TMP, 'child-data');
    const script = path.join(TMP, 'child.mjs');
    fs.writeFileSync(
      script,
      `import http from 'node:http';
const { Store } = await import(${JSON.stringify(SRC('store.mjs'))});
const { AppServer } = await import(${JSON.stringify(SRC('server.mjs'))});
const store = new Store();
store.data.backend = { kind: 'native', distro: '' };
const h = new AppServer({ store, token: 'tok' });
const port = await h.listen(0);
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { cookie: 'orbix=tok' } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', rej);
});
const sse = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie: 'orbix=tok' } }, (r) => r.resume());
sse.on('error', () => {});
if (await get('/api/state') !== 200) throw new Error('state failed');
await new Promise((r) => setTimeout(r, 100));
await h.shutdown();
console.log('SHUTDOWN-DONE');
`,
    );
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [script], { env: { ...process.env, ORBIX_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.stderr.on('data', (d) => (stderr += d));
      const killer = setTimeout(() => {
        c.kill('SIGKILL');
        reject(new Error(`child still running 20s after shutdown() (open handle). stdout=${stdout} stderr=${stderr}`));
      }, 20000);
      c.on('exit', (code, signal) => {
        clearTimeout(killer);
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /SHUTDOWN-DONE/);
    assert.ok(Date.now() - started < 15000, 'process lingered after shutdown');
  });
});

describe('security headers', () => {
  test('the UI gets a strict CSP: no inline styles or scripts, no frames, no workers', async () => {
    const r = await raw(port, 'GET', '/index.html', { headers: { cookie: COOKIE } });
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    for (const d of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  });
  test('static files, API answers, the token redirect and 401s all carry the same protective headers', async () => {
    const answers = [
      await raw(port, 'GET', '/css/app.css', { headers: { cookie: COOKIE } }),
      await api('GET', '/api/procs'),
      await raw(port, 'GET', `/?t=${TOKEN}`),
      await raw(port, 'GET', '/api/state'),
    ];
    for (const r of answers) {
      assert.equal(r.headers['x-content-type-options'], 'nosniff', String(r.status));
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    }
  });
});
