import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTrip, flushPendingTripChanges, loadTrips, pendingTripSyncCount, saveTrip, supabase } from './repository.js';
import { readCloudCache } from './offline.js';

const session = { user: { id: 'sync-user' } };
const trip = (id, title) => ({ id, title, destination: 'Lisbon', startDate: '2026-09-01', endDate: '2026-09-03', days: [], expenses: [], journals: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeCloud() {
  const rows = new Map();
  const started = [];
  let gate = null;
  const request = (label, apply) => ({
    then(resolve, reject) {
      started.push(label);
      return (gate || Promise.resolve()).then(apply).then(resolve, reject);
    }
  });
  const store = (row) => {
    rows.set(row.id, { ...row, created_at: rows.get(row.id)?.created_at || '2026-08-01T00:00:00.000Z', updated_at: new Date().toISOString() });
    return rows.get(row.id);
  };
  const table = {
    select: () => ({ order: () => request('select', () => ({ data: [...rows.values()], error: null })) }),
    upsert: (row) => ({
      ...request(`upsert:${row.id}`, () => { store(row); return { error: null }; }),
      select: () => ({ single: () => request(`upsert:${row.id}`, () => ({ data: store(row), error: null })) })
    }),
    delete: () => ({ eq: (_column, id) => request(`delete:${id}`, () => { rows.delete(id); return { error: null }; }) })
  };
  return {
    rows,
    started,
    from: () => table,
    pause() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    }
  };
}

function withCloud(run) {
  return async () => {
    const values = new Map();
    let online = true;
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key)
    };
    Object.defineProperty(globalThis, 'navigator', { get: () => ({ onLine: online }), configurable: true });
    const cloud = fakeCloud();
    const originalFrom = supabase.from;
    supabase.from = cloud.from;
    try {
      await run({ cloud, setOnline: (value) => { online = value; } });
    } finally {
      supabase.from = originalFrom;
      delete globalThis.localStorage;
      delete globalThis.navigator;
    }
  };
}

test('a trip deleted online stays deleted after older queued edits flush', withCloud(async ({ cloud, setOnline }) => {
  setOnline(false);
  const { trips } = await saveTrip(trip('trip-a', 'Offline edit'), session, []);
  setOnline(true);
  await deleteTrip('trip-a', session, trips);
  await flushPendingTripChanges(session);

  assert.equal(cloud.rows.has('trip-a'), false);
  assert.equal(pendingTripSyncCount(session), 0);
}));

test('an older queued edit cannot overwrite a newer online save', withCloud(async ({ cloud, setOnline }) => {
  setOnline(false);
  const first = await saveTrip(trip('trip-a', 'Older'), session, []);
  setOnline(true);
  await saveTrip(trip('trip-a', 'Newer'), session, first.trips);
  await flushPendingTripChanges(session);

  assert.equal(cloud.rows.get('trip-a').title, 'Newer');
  assert.equal(pendingTripSyncCount(session), 0);
}));

test('changes queued while a flush is running are kept', withCloud(async ({ cloud, setOnline }) => {
  setOnline(false);
  const first = await saveTrip(trip('trip-a', 'A'), session, []);
  setOnline(true);
  const release = cloud.pause();
  const flushing = flushPendingTripChanges(session);
  await tick();

  setOnline(false);
  await saveTrip(trip('trip-b', 'B'), session, first.trips);
  release();
  await flushing;
  setOnline(true);
  await flushPendingTripChanges(session);

  assert.deepEqual([...cloud.rows.keys()].sort(), ['trip-a', 'trip-b']);
  assert.equal(pendingTripSyncCount(session), 0);
}));

test('a cloud refresh keeps pending deletions and edits', withCloud(async ({ setOnline }) => {
  const created = await saveTrip(trip('trip-a', 'Server A'), session, []);
  const both = await saveTrip(trip('trip-b', 'Server B'), session, created.trips);
  setOnline(false);
  const remaining = await deleteTrip('trip-a', session, both.trips);
  await saveTrip(trip('trip-b', 'Offline B'), session, remaining);
  setOnline(true);

  const loaded = await loadTrips(session);
  assert.deepEqual(loaded.map(({ id, title }) => [id, title]), [['trip-b', 'Offline B']]);
  assert.deepEqual(readCloudCache(session.user.id).map(({ id }) => id), ['trip-b']);
  assert.equal(pendingTripSyncCount(session), 2);
}));

test('an online save waits for a running flush', withCloud(async ({ cloud, setOnline }) => {
  setOnline(false);
  const queued = await saveTrip(trip('trip-a', 'Queued'), session, []);
  setOnline(true);
  const release = cloud.pause();
  const flushing = flushPendingTripChanges(session);
  const saving = saveTrip(trip('trip-a', 'Latest'), session, queued.trips);
  await tick();

  assert.deepEqual(cloud.started, ['upsert:trip-a']);
  release();
  await Promise.all([flushing, saving]);
  assert.equal(cloud.rows.get('trip-a').title, 'Latest');
  assert.equal(pendingTripSyncCount(session), 0);
}));

test('an offline edit made while an online save waits in line is kept', withCloud(async ({ cloud, setOnline }) => {
  setOnline(false);
  const queued = await saveTrip(trip('trip-b', 'Other trip'), session, []);
  setOnline(true);
  const release = cloud.pause();
  const flushing = flushPendingTripChanges(session);
  const saving = saveTrip(trip('trip-a', 'Online'), session, queued.trips);
  await tick();

  setOnline(false);
  await saveTrip(trip('trip-a', 'Offline, newer'), session, queued.trips);
  setOnline(true);
  release();
  await Promise.all([flushing, saving]);
  await flushPendingTripChanges(session);

  assert.equal(cloud.rows.get('trip-a').title, 'Offline, newer');
  assert.equal(pendingTripSyncCount(session), 0);
}));
