import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySyncError, clearFailedSyncForTrip, enqueueSync, MAX_SYNC_ATTEMPTS, moveSyncEntriesToFailed, readCloudCache, readFailedSync, readSyncQueue, recordSyncAttempt, removeSyncEntries, writeCloudCache } from './offline.js';

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

test('removes finished queue entries without dropping later or older-format ones', () => withStorage(() => {
  localStorage.setItem('roamly-cloud-queue-v1:user-a', JSON.stringify([
    { type: 'delete', tripId: 'legacy-trip', queuedAt: '2026-09-01T00:00:00.000Z' }
  ]));
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1' } });
  const finished = readSyncQueue('user-a');
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-2', row: { id: 'trip-2' } });
  removeSyncEntries('user-a', finished);
  assert.deepEqual(readSyncQueue('user-a').map(({ tripId }) => tripId), ['trip-2']);
}));

test('classifies sync errors as retry or reject', () => {
  const cases = [
    [{ message: 'Failed to fetch' }, 0, 'retry'],
    [{ message: 'anything' }, 401, 'retry'],
    [{ message: 'anything' }, 408, 'retry'],
    [{ message: 'anything' }, 429, 'retry'],
    [{ message: 'anything' }, 503, 'retry'],
    [{ message: 'anything', code: 'PGRST301' }, 400, 'retry'],
    [{ message: 'anything', code: 'PGRST302' }, 403, 'retry'],
    [{ message: 'JWT expired' }, 400, 'retry'],
    [{ message: 'user not authenticated' }, 403, 'retry'],
    [{ message: 'permission denied' }, 403, 'reject'],
    [{ message: 'new row violates row-level security policy' }, 403, 'reject'],
    [{ message: 'bad request' }, 400, 'reject'],
    [{ message: 'check violation', code: '23514' }, undefined, 'reject'],
    [{ message: 'invalid uuid', code: '22P02' }, undefined, 'reject'],
    [{ message: 'no such column', code: '42703' }, undefined, 'reject'],
    [{ message: 'bad', code: 'PGRST204' }, undefined, 'reject'],
    [{ message: 'something odd', code: 'XX000' }, undefined, 'retry'],
    [{ message: 'something odd' }, undefined, 'retry']
  ];
  for (const [error, status, expected] of cases) assert.equal(classifySyncError(error, status), expected, JSON.stringify([error, status]));
});

test('classifies everything as retry while the device is offline', () => {
  Object.defineProperty(globalThis, 'navigator', { get: () => ({ onLine: false }), configurable: true });
  try { assert.equal(classifySyncError({ message: 'check violation', code: '23514' }, 400), 'retry'); } finally { delete globalThis.navigator; }
});

test('moves rejected entries to the failed list, keeping the newest per trip', () => withStorage(() => {
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1', title: 'First' } });
  moveSyncEntriesToFailed('user-a', readSyncQueue('user-a'), { error: { message: 'old', code: '23514' }, status: 400 });
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1', title: 'Second' } });
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-2', row: { id: 'trip-2', title: 'Other' } });
  moveSyncEntriesToFailed('user-a', readSyncQueue('user-a').slice(0, 1), { error: new Error('nope'), status: 403 });

  assert.deepEqual(readSyncQueue('user-a').map(({ tripId }) => tripId), ['trip-2']);
  const failed = readFailedSync('user-a');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].row.title, 'Second');
  assert.equal(failed[0].error.message, 'nope');
  assert.equal(failed[0].error.status, 403);
  assert.ok(Date.parse(failed[0].failedAt));
  clearFailedSyncForTrip('user-a', 'trip-1');
  assert.deepEqual(readFailedSync('user-a'), []);
  assert.equal(localStorage.getItem('roamly-cloud-failed-v1:user-a'), null);
}));

test('truncates failure messages and records the code', () => withStorage(() => {
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1' } });
  moveSyncEntriesToFailed('user-a', readSyncQueue('user-a'), { error: { message: 'x'.repeat(300), code: '23514' }, status: 400 });
  const [entry] = readFailedSync('user-a');
  assert.equal(entry.error.message.length, 200);
  assert.equal(entry.error.code, '23514');
}));

test('counts sync attempts on the queued entry', () => withStorage(() => {
  enqueueSync('user-a', { type: 'upsert', tripId: 'trip-1', row: { id: 'trip-1' } });
  const [entry] = readSyncQueue('user-a');
  assert.equal(recordSyncAttempt('user-a', entry), 1);
  assert.equal(recordSyncAttempt('user-a', entry), 2);
  assert.equal(readSyncQueue('user-a')[0].attempts, 2);
  assert.equal(MAX_SYNC_ATTEMPTS, 5);
}));
