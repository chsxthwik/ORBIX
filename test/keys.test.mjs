import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboOf, comboProblem, effectiveKeys, actionFor, assignCombo, removeCombo, resetKeys, ACTIONS } from '../web/js/keys.mjs';

const ev = (code, mods = {}, key = '') => ({ code, key: key || code, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: false });

test('comboOf names keys by their place, modifiers in a fixed order', () => {
  assert.equal(comboOf(ev('KeyK', { ctrl: true }, 'k')), 'Ctrl+K');
  assert.equal(comboOf(ev('Slash', { ctrl: true, shift: true }, '?')), 'Ctrl+Shift+/');
  assert.equal(comboOf(ev('Comma', { ctrl: true }, ',')), 'Ctrl+,');
  assert.equal(comboOf(ev('ArrowLeft', { alt: true }, 'ArrowLeft')), 'Alt+←');
  assert.equal(comboOf(ev('Digit2', { ctrl: true }, '2')), 'Ctrl+2');
  assert.equal(comboOf(ev('NumpadAdd', { ctrl: true }, '+')), 'Ctrl+=');
  assert.equal(comboOf(ev('F2', {}, 'F2')), 'F2');
  assert.equal(comboOf(ev('ShiftLeft', { shift: true }, 'Shift')), '');
  assert.equal(comboOf({ code: '', key: 'ä', ctrlKey: true }), 'Ctrl+Ä');
});

test('comboProblem keeps typing and the message box safe', () => {
  assert.equal(comboProblem('Ctrl+K'), '');
  assert.equal(comboProblem('F5'), '');
  assert.match(comboProblem('K'), /Ctrl or Alt/);
  assert.match(comboProblem('Shift+K'), /Ctrl or Alt/);
  assert.match(comboProblem('Alt+Enter'), /message box/);
  assert.match(comboProblem('Alt+3'), /open conversations/);
  assert.match(comboProblem(''), /Press/);
});

test('custom keys replace defaults; assigning takes the combo from its old action', () => {
  assert.deepEqual(effectiveKeys({}).search, ['Ctrl+K']);
  assert.equal(actionFor('Ctrl+K', {}).id, 'search');
  const { keys, takenFrom } = assignCombo({}, 'settings', 'Ctrl+K');
  assert.equal(takenFrom.id, 'search');
  assert.deepEqual(effectiveKeys(keys).search, []);
  assert.deepEqual(effectiveKeys(keys).settings, ['Ctrl+,', 'Ctrl+K']);
  assert.equal(actionFor('Ctrl+K', keys).id, 'settings');
  const back = removeCombo(keys, 'settings', 'Ctrl+K');
  assert.deepEqual(back.settings, undefined, 'equal to the defaults again, so not stored');
  assert.deepEqual(resetKeys(keys, 'search').search, undefined);
  assert.deepEqual(resetKeys(keys), {});
});

test('every default is a valid, unique combo', () => {
  const seen = new Set();
  for (const a of ACTIONS) for (const k of a.keys) {
    assert.equal(comboProblem(k), '', `${a.id}: ${k}`);
    assert.ok(!seen.has(k), `duplicate ${k}`);
    seen.add(k);
  }
});
