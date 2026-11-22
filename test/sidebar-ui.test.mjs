// The sidebar's rules that can drift without anyone noticing: a project keeps its colour, every shortcut is
// written one way, and the sidebar shows shortcuts only through the shared hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tileIndex, tileLetter, TILE_COUNT } from '../web/js/tile.mjs';
import { ACTIONS } from '../web/js/keys.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('a project tile colour is deterministic, in range and ignores case and outer space', () => {
  const names = ['shop-api', 'billing-service', 'ORBIX-AGENT', 'Downloads', 'web', 'api', 'docs', 'mobile-app', 'infra', 'données', '项目', '🚀 rocket'];
  for (const n of names) {
    const i = tileIndex(n);
    assert.ok(Number.isInteger(i) && i >= 0 && i < TILE_COUNT, `${n} -> ${i}`);
    assert.equal(tileIndex(n), i, 'same name, same colour');
    assert.equal(tileIndex(`  ${n.toUpperCase()} `), tileIndex(n.toLowerCase()));
  }
  assert.equal(tileIndex(''), 0);
  assert.equal(tileIndex('shop-api'), tileIndex('shop-api'));
  // the eight colours are all used by ordinary project names
  const used = new Set(Array.from({ length: 200 }, (_, k) => tileIndex(`project-${k}`)));
  assert.equal(used.size, TILE_COUNT);
});

test('a tile letter is the first letter or digit, upper-cased', () => {
  assert.equal(tileLetter('shop-api'), 'S');
  assert.equal(tileLetter('_9lives'), '9');
  assert.equal(tileLetter('élan'), 'É');
  assert.equal(tileLetter('---'), '·');
});

test('every shortcut is written one way: Ctrl, Alt, Shift, then the key', () => {
  for (const a of ACTIONS) for (const k of a.keys) assert.match(k, /^(Ctrl\+)?(Alt\+)?(Shift\+)?(?:[^+]+|\+)$/, `${a.id}: ${k}`);
});

test('the sidebar shows shortcuts only through the shared hint, the same for every row', () => {
  const main = read('web/js/main.js');
  const side = main.slice(main.indexOf('function drawSidebar()'), main.indexOf('function runningList()'));
  assert.doesNotMatch(side, /h\('kbd'/, 'no keycaps in the sidebar');
  for (const id of ['new', 'search', 'settings']) assert.match(side, new RegExp(`keyHint\\(firstKey\\(S\\.ui\\.keys, '${id}'\\)\\)`), id);
  assert.match(side, /keyHint\(shortcut\)/, 'every page link');
  const css = read('web/css/side.css');
  assert.match(css, /\.khint \{[^}]*color: var\(--fg-3\)[^}]*tabular-nums/);
});

test('the sidebar icons are one family: outline 1.75, nothing filled', () => {
  const src = read('web/js/side-icons.js');
  assert.match(src, /'stroke-width': '1\.75'/);
  assert.match(src, /fill: 'none'/);
  for (const name of ['new', 'search', 'customizations', 'skills', 'automations', 'runs', 'review', 'settings']) assert.match(src, new RegExp(`\\b${name}: '`), name);
});
