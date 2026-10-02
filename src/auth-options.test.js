import test from 'node:test';
import assert from 'node:assert/strict';
import { signInOptions } from './auth-options.js';

test('native iOS is email-only until Sign in with Apple exists', () => {
  assert.deepEqual(signInOptions('ios'), { google: false, email: true });
});

test('web and Android keep Google next to email', () => {
  assert.deepEqual(signInOptions('web'), { google: true, email: true });
  assert.deepEqual(signInOptions('android'), { google: true, email: true });
});

test('an unknown or missing platform behaves like the web', () => {
  for (const platform of [undefined, null, '', 'electron']) assert.deepEqual(signInOptions(platform), { google: true, email: true });
});

test('email sign-in is always offered', () => {
  for (const platform of ['ios', 'android', 'web', undefined]) assert.equal(signInOptions(platform).email, true);
});
