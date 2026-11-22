// The side panel's launcher (New tab page): grouped rows, one shortcut hint, and a reason on every row that cannot
// open, so nothing is dimmed without saying why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../web/js/panels.js', import.meta.url), 'utf8');
const body = (name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, name);
  return src.slice(i, src.indexOf('\n}\n', i));
};
const rows = body('surfaces').split('\n').filter((l) => /\{ group: /.test(l));

test('every surface sits in one of the three groups, in order', () => {
  assert.equal(rows.length, 12);
  const groups = rows.map((l) => /group: '([^']+)'/.exec(l)[1]);
  assert.deepEqual([...new Set(groups)], ['Workspace', 'Tools', 'Conversation']);
  for (const l of rows) assert.match(l, /id: '[\w]+'.*label: '[^']+'/);
});

test('a row that can be unavailable always says why', () => {
  const off = rows.filter((l) => /\boff:/.test(l));
  assert.ok(off.length >= 6);
  for (const l of off) assert.match(l, /\bwhy: (first|'[^']{8,}')/, l.trim());
  assert.match(body('surfaces'), /const first = 'Open a conversation first'/);
});

test('unavailable rows stay focusable, are marked aria-disabled and show the reason as a second line', () => {
  const draw = body('drawNew');
  assert.match(draw, /'aria-disabled': it\.off \? 'true' : null/);
  assert.doesNotMatch(draw, /tabindex|disabled: true/);
  assert.match(draw, /it\.off \? 'nt-why' : 'nt-note'/);
  const css = fs.readFileSync(new URL('../web/css/shell.css', import.meta.url), 'utf8');
  const off = /\.nt-it\.off \{([^}]*)\}/.exec(css)?.[1] || '';
  assert.doesNotMatch(off, /opacity/, 'no mystery dimming');
  assert.match(css, /\.nt-note, \.nt-why \{[^}]*color: var\(--fg-2\)/);
});

test('the launcher writes shortcuts with the shared hint, not keycaps', () => {
  const draw = body('drawNew');
  assert.match(draw, /keyHint\(key\)/);
  assert.doesNotMatch(draw, /h\('kbd'/);
});
