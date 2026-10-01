import test from 'node:test';
import assert from 'node:assert/strict';
import { recapShareOptions } from './sharing.js';

test('a mobile recap can be shared as text without a hosted website', () => {
  assert.deepEqual(recapShareOptions({ title: 'Paris · Roamly', text: '2 gün · 24 durak' }), {
    title: 'Paris · Roamly', text: '2 gün · 24 durak'
  });
});

test('sharing excludes device-local and non-web links', () => {
  for (const url of ['roamly://localhost', 'https://localhost', 'http://127.0.0.1:5173', 'javascript:alert(1)', 'invalid']) {
    assert.deepEqual(recapShareOptions({ title: 'Paris', text: 'Özet', url }), { title: 'Paris', text: 'Özet' });
  }
});

test('web recaps may include a public HTTPS link', () => {
  assert.equal(recapShareOptions({ title: 'Paris', text: 'Özet', url: 'https://example.com/' }).url, 'https://example.com/');
});
