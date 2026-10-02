import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinate, hasLocation } from './coords.js';

test('missing coordinates are null, never 0', () => {
  for (const value of [null, undefined, '', '   ', NaN, Infinity, 'abc', true, [], {}]) assert.equal(coordinate(value), null, String(value));
});

test('real zero and numeric strings are kept', () => {
  assert.equal(coordinate(0), 0);
  assert.equal(coordinate('0'), 0);
  assert.equal(coordinate('-12.5'), -12.5);
  assert.equal(coordinate(41.9), 41.9);
});

test('hasLocation needs both coordinates', () => {
  assert.equal(hasLocation({ lat: 0, lng: 0 }), true);
  assert.equal(hasLocation({ lat: 0, lng: null }), false);
  assert.equal(hasLocation({ lat: '', lng: '' }), false);
  assert.equal(hasLocation({}), false);
  assert.equal(hasLocation(null), false);
});
