// The logo system: the app icon has every size Windows asks for, the menu row's top left is the mark alone, and
// every provider has a mark or a deliberate fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readIco, ICO_SIZES } from '../tools/icons.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root));
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];

test('assets/icon.ico holds 16, 20, 24, 32, 40, 48, 64 and 256 px, each a PNG of its own size', () => {
  assert.deepEqual(ICO_SIZES, [16, 20, 24, 32, 40, 48, 64, 256]);
  const ico = read('assets/icon.ico');
  const entries = readIco(ico);
  assert.deepEqual(entries.map((e) => e.size), ICO_SIZES);
  for (const e of entries) assert.ok(e.png, `${e.size}px is a PNG`);
});

test('assets/icon.png is 512 px', () => {
  assert.deepEqual(pngSize(read('assets/icon.png')), [512, 512]);
});

test('the top left of the menu row is the mark alone, not the name', () => {
  const shell = read('web/js/shell.js').toString();
  assert.doesNotMatch(shell, /\bwordmark\b/i, 'the menu row draws no wordmark');
  assert.match(shell, /name === 'ORBIX' \? \[logo\(\d+, \{ alive: true \}\)\]/, 'the menu row shows the mark');
});

test('Home and an empty conversation show ORBIX in animated ASCII block letters, five letters on one grid', () => {
  const dom = read('web/js/dom.js').toString();
  const word = new Function(`return ${/const WORD = (\[[\s\S]*?\]);\n/.exec(dom)[1]}`)();
  assert.equal(word.length, 5, 'O, R, B, I and X');
  for (const g of word) {
    assert.equal(g.length, 5, 'every letter is five rows tall');
    assert.ok(g.every((r) => r.length === g[0].length && /^[#.]+$/.test(r)), 'rows of one width, pixels and gaps only');
  }
  const ramp = new Function(`return ${/const RAMP = ('[^']*')/.exec(dom)[1]}`)();
  assert.match(ramp, /^[\x20-\x7e]+$/, 'the letters are drawn with ASCII characters');
  assert.match(dom, /prefers-reduced-motion: reduce/, 'reduced motion shows the letters still');
  assert.match(read('web/js/home.js').toString(), /wordmark\(\)/, 'Home shows it');
  assert.match(read('web/js/session.js').toString(), /wordmark\(\)/, 'an empty conversation shows it');
});

test('every provider has a mark, or a deliberate neutral one', () => {
  const brands = read('web/js/brands.js').toString();
  const marks = new Set(Object.keys(JSON.parse(/const MARKS = (\{.*?\});\n/s.exec(brands)[1])));
  const same = JSON.parse(/const SAME_MAKER = (\{[^}]*\})/.exec(brands)[1].replace(/'/g, '"').replace(/(\w[\w-]*):/g, '"$1":').replace(/""/g, '"'));
  const providers = [...read('src/engine/providers.mjs').toString().matchAll(/\{ id: '([\w-]+)', name:/g)].map((m) => m[1]);
  assert.ok(providers.length >= 15);
  const neutral = new Set(['custom']); // your own server: the neutral chip icon, on purpose
  for (const id of providers) assert.ok(marks.has(id) || marks.has(same[id]) || neutral.has(id), id);
  // every mark has a measured frame, so it is drawn at the same optical size as the others
  const box = JSON.parse(/const BOX = (\{.*?\});/.exec(brands)[1]);
  for (const id of marks) assert.ok(box[id]?.length === 4, `frame for ${id}`);
});
