import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_CONSENT_KEY, AI_CONSENT_VERSION, clearAiConsent, getAiConsent, needsAiConsent, setAiConsent } from './ai-consent.js';

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); }, data };
};
const brokenStorage = () => ({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } });

test('consent is needed until it is stored', () => {
  const storage = memoryStorage();
  assert.equal(needsAiConsent(storage), true);
  assert.equal(getAiConsent(storage), null);
  const record = setAiConsent(storage, { now: new Date('2026-10-02T10:00:00Z') });
  assert.deepEqual(record, { version: AI_CONSENT_VERSION, acceptedAt: '2026-10-02T10:00:00.000Z' });
  assert.deepEqual(JSON.parse(storage.data.get(AI_CONSENT_KEY)), record);
  assert.equal(needsAiConsent(storage), false);
  assert.deepEqual(getAiConsent(storage), record);
});

test('an older stored version asks again, a newer or equal one does not', () => {
  const storage = memoryStorage({ [AI_CONSENT_KEY]: JSON.stringify({ version: 1, acceptedAt: '2026-01-01T00:00:00.000Z' }) });
  assert.equal(needsAiConsent(storage, 1), false);
  assert.equal(needsAiConsent(storage, 2), true);
  assert.equal(needsAiConsent(memoryStorage({ [AI_CONSENT_KEY]: JSON.stringify({ version: 3, acceptedAt: 'x' }) }), 2), false);
});

test('withdrawing clears the key and the next request asks again', () => {
  const storage = memoryStorage();
  setAiConsent(storage);
  assert.equal(clearAiConsent(storage), true);
  assert.equal(storage.data.has(AI_CONSENT_KEY), false);
  assert.equal(needsAiConsent(storage), true);
});

test('malformed stored values never count as consent', () => {
  for (const raw of ['not json', '{}', 'null', '[]', '"yes"', '{"version":"1"}', '{"version":0}', '{"version":1.5}', '{"acceptedAt":"2026-01-01"}']) {
    const storage = memoryStorage({ [AI_CONSENT_KEY]: raw });
    assert.equal(getAiConsent(storage), null, raw);
    assert.equal(needsAiConsent(storage), true, raw);
  }
});

test('a record without a timestamp still counts, with an empty acceptedAt', () => {
  const storage = memoryStorage({ [AI_CONSENT_KEY]: JSON.stringify({ version: 1 }) });
  assert.deepEqual(getAiConsent(storage), { version: 1, acceptedAt: '' });
  assert.equal(needsAiConsent(storage), false);
});

test('unavailable storage fails closed without throwing', () => {
  const storage = brokenStorage();
  assert.equal(needsAiConsent(storage), true);
  assert.equal(getAiConsent(storage), null);
  assert.equal(setAiConsent(storage), null);
  assert.equal(clearAiConsent(storage), false);
  assert.equal(needsAiConsent(null), true);
  assert.equal(setAiConsent(null), null);
});
