import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstName } from '../src/server.mjs';

test('Home greets you by the first name of your Windows account, never by a generic one', () => {
  assert.equal(firstName('RAVI'), 'Ravi');
  assert.equal(firstName('anusha.ch'), 'Anusha');
  assert.equal(firstName('john_doe'), 'John');
  assert.equal(firstName('Administrator'), '');
  assert.equal(firstName('user'), '');
  assert.equal(firstName('x'), '', 'one letter is not a name');
  assert.equal(firstName('dev123'), '', 'digits are not a name');
  assert.equal(firstName(''), '');
});
