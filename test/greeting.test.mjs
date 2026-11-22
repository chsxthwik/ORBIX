import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDisplayName } from '../src/server.mjs';

test('Home greets you only by the name you set, cleaned to one short line', () => {
  assert.equal(cleanDisplayName('  QUANTUM  '), 'QUANTUM');
  assert.equal(cleanDisplayName('Ada\n Lovelace\t'), 'Ada Lovelace');
  assert.equal(cleanDisplayName('x'.repeat(60)).length, 40);
  assert.equal(cleanDisplayName(undefined), '');
  assert.equal(cleanDisplayName('\u0007'), '');
});
