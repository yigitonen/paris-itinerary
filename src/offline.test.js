import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueSync, readCloudCache, readSyncQueue, writeCloudCache } from './offline.js';

function withStorage(run) {
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  try { run(); } finally { delete globalThis.localStorage; }
}

test('keeps an authenticated trip cache per user', () => withStorage(() => {
  writeCloudCache('user-a', [{ id: 'trip-1' }]);
  writeCloudCache('user-b', [{ id: 'trip-2' }]);
  assert.deepEqual(readCloudCache('user-a'), [{ id: 'trip-1' }]);
  assert.deepEqual(readCloudCache('user-b'), [{ id: 'trip-2' }]);
}));

test('compacts queued mutations to the latest operation per trip', () => withStorage(() => {
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1', title: 'First' } });
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1', title: 'Latest' } });
  enqueueSync('user-a', { type: 'delete', tripId: 'trip-1' });
  assert.deepEqual(readSyncQueue('user-a').map(({ type, tripId }) => ({ type, tripId })), [
    { type: 'delete', tripId: 'trip-1' }
  ]);
}));
