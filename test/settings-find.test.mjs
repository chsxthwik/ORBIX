// Ctrl+K finds settings by name and points at the row on its page; a name that is not on any page points nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js');
const settings = fs.readFileSync(path.join(WEB, 'settings.js'), 'utf8');
const others = fs.readdirSync(WEB).filter((f) => /\.m?js$/.test(f)).map((f) => fs.readFileSync(path.join(WEB, f), 'utf8')).join('\n');
// Entries that open a page without pointing at one row on it.
const PAGE_ONLY = new Set(['API keys', 'Local models']);

test('every setting Ctrl+K finds is a label on its page', () => {
  const find = /const FIND = \[([\s\S]*?)\n\];/.exec(settings)?.[1];
  assert.ok(find, 'FIND list in settings.js');
  const labels = [...find.matchAll(/\['([^']+)', '([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(labels.length > 40);
  for (const l of labels) {
    if (PAGE_ONLY.has(l)) continue;
    const uses = others.split(`'${l}'`).length - 1;
    assert.ok(uses >= 2, `"${l}" is a row or group label somewhere, not only in FIND`);
  }
});
