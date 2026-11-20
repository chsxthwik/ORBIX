import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, CATEGORIES, FEATURED, configFor } from '../web/js/catalog.mjs';

test('every marketplace entry builds a config ORBIX can save', () => {
  const ids = new Set();
  for (const e of CATALOG) {
    assert.ok(!ids.has(e.id), `unique id ${e.id}`);
    ids.add(e.id);
    assert.ok(CATEGORIES.includes(e.cat), `${e.id} category`);
    assert.match(e.id, /^[a-z0-9-]+$/, 'usable as a server name');
    const values = Object.fromEntries((e.fields || []).map((f) => [f.key, f.folder ? 'C:\\work' : 'x-token']));
    const c = configFor(e, values);
    if (c.url) {
      assert.match(c.url, /^https?:\/\//);
      for (const v of Object.values(c.headers || {})) assert.equal(typeof v, 'string');
    } else {
      assert.equal(c.command, 'npx');
      assert.ok(Array.isArray(c.args) && c.args.every((a) => typeof a === 'string' && a));
      for (const [k, v] of Object.entries(c.env || {})) assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/) && assert.equal(typeof v, 'string');
    }
    if (e.fields?.length) assert.throws(() => configFor(e, {}), /is needed/);
  }
  assert.ok(ids.has(FEATURED));
});
