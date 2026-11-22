// Network access rules for web_fetch: which sites are denied, allowed without asking, or asked about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbix-net-'));
process.env.ORBIX_DATA = path.join(TMP, 'data');
fs.mkdirSync(process.env.ORBIX_DATA, { recursive: true });
const { cleanSiteRules, siteVerdict } = await import('../src/engine/policy.mjs');
const { EngineConfig } = await import('../src/engine/store.mjs');
const { AgentProc } = await import('../src/engine/proc.mjs');
const { webFetch } = await import('../src/engine/webfetch.mjs');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('cleanSiteRules keeps sites, subdomain rules and paths, and drops junk', () => {
  assert.deepEqual(cleanSiteRules(['https://Docs.Python.org/3/', '*.github.com', 'example.com/docs/', 'bad site', '', 'a..b', '*', 'localhost:3000', 'docs.python.org/3']), ['docs.python.org/3', '*.github.com', 'example.com/docs', '*', 'localhost:3000']);
});

test('siteVerdict: deny wins, allow lets through, an allowed list makes the rest ask', () => {
  const rules = { allow: ['github.com', 'docs.python.org/3'], deny: ['gist.github.com', 'evil.test'] };
  assert.equal(siteVerdict('https://github.com/x', rules), 'allow');
  assert.equal(siteVerdict('https://api.github.com/repos', rules), 'allow', 'a site covers its subdomains');
  assert.equal(siteVerdict('https://gist.github.com/a', rules), 'deny');
  assert.equal(siteVerdict('https://docs.python.org/3/library', rules), 'allow');
  assert.equal(siteVerdict('https://docs.python.org/2/library', rules), 'ask');
  assert.equal(siteVerdict('https://docs.python.org/30', rules), 'ask', 'a path rule matches whole segments');
  assert.equal(siteVerdict('https://notgithub.com', rules), 'ask');
  assert.equal(siteVerdict('https://example.org', { allow: [], deny: ['evil.test'] }), 'any');
  assert.equal(siteVerdict('https://www.evil.test/x', { allow: [], deny: ['evil.test'] }), 'deny');
  assert.equal(siteVerdict('https://a.b.example.com', { allow: ['*.example.com'] }), 'allow');
  assert.equal(siteVerdict('https://example.com', { allow: ['*.example.com'] }), 'ask', '*. means subdomains only');
  assert.equal(siteVerdict('https://x.test', { deny: ['*'] }), 'deny');
});

test('EngineConfig stores the rules cleaned and shows them to the UI', () => {
  const cfg = new EngineConfig(path.join(TMP, 'cfg'));
  fs.mkdirSync(path.join(TMP, 'cfg'), { recursive: true });
  cfg.setNetwork({ allow: ['https://GitHub.com/'], deny: ['x y'] });
  assert.deepEqual(cfg.publicView().network, { allow: ['github.com'], deny: [] });
  cfg.setNetwork({ deny: ['evil.test'] });
  assert.deepEqual(cfg.data.network, { allow: ['github.com'], deny: ['evil.test'] });
  assert.deepEqual(new EngineConfig(path.join(TMP, 'cfg')).data.network, { allow: ['github.com'], deny: ['evil.test'] }, 'saved');
});

test('web_fetch asks for sites off the allowed list, in every mode, until allowed for the session', () => {
  const ask = (approvals, url, network, allow = []) => AgentProc.prototype._mustAsk.call({ config: { data: { approvals, trusted: [], network } }, allowAlways: new Set(allow), _outside: () => false, _needsApproval: () => false }, { name: 'web_fetch' }, { url });
  const net = { allow: ['github.com'], deny: [] };
  assert.equal(ask('ask', 'https://github.com/a', net), false);
  assert.equal(ask('ask', 'https://example.com', net), true);
  assert.equal(ask('auto', 'https://example.com', net), true, 'Full access does not skip a rule you wrote');
  assert.equal(ask('ask', 'https://example.com', net, ['web_fetch:site']), false);
  assert.equal(ask('ask', 'https://example.com', { allow: [], deny: [] }), false, 'no allowed list: reads as before');
});

test('webFetch refuses a denied site, also after a redirect', async () => {
  const srv = http.createServer((q, r) => (q.url === '/go' ? r.writeHead(302, { location: 'http://127.0.0.2:1/x' }).end() : r.end('ok')));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const denied = (u) => siteVerdict(u, { deny: ['127.0.0.2'] }) === 'deny';
    const direct = await webFetch({ url: 'http://127.0.0.2:1/' }, { allowHost: async () => true, denied });
    assert.equal(direct.isError, true);
    assert.match(direct.text, /network rules/);
    const hop = await webFetch({ url: `${base}/go` }, { allowHost: async () => true, denied });
    assert.equal(hop.isError, true);
    assert.match(hop.text, /network rules: 127\.0\.0\.2/);
  } finally {
    srv.close();
  }
});
