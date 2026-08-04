import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTrip, pendingTripSyncCount, saveTrip } from './repository.js';
import { readCloudCache, readSyncQueue } from './offline.js';

test('signed-in edits are cached and compacted while offline', async () => {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });

  const session = { user: { id: 'offline-user' } };
  const trip = {
    id: 'offline-trip',
    title: 'Offline Lisbon',
    destination: 'Lisbon',
    startDate: '2026-09-01',
    endDate: '2026-09-03',
    days: [],
    expenses: [],
    journals: []
  };

  try {
    const saved = await saveTrip(trip, session, []);
    assert.equal(saved.pendingSync, true);
    assert.equal(readCloudCache(session.user.id)[0].title, 'Offline Lisbon');
    assert.equal(pendingTripSyncCount(session), 1);

    const remaining = await deleteTrip(trip.id, session, saved.trips);
    assert.deepEqual(remaining, []);
    assert.deepEqual(readSyncQueue(session.user.id).map(({ type, tripId }) => ({ type, tripId })), [
      { type: 'delete', tripId: 'offline-trip' }
    ]);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.navigator;
  }
});
