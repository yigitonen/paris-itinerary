import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTrip, failedTripSyncCount, flushPendingTripChanges, loadTrips, migrateGuestTrips, pendingTripSyncCount, saveTrip, supabase } from './repository.js';
import { createDemoTrip } from './data.js';
import { planSizeBytes } from './trip-plan.js';
import { GUEST_STORAGE_KEY } from './config.js';
import { readCloudCache, readSyncQueue } from './offline.js';

const session = { user: { id: 'sync-user' } };
const trip = (id, title) => ({ id, title, destination: 'Lisbon', startDate: '2026-09-01', endDate: '2026-09-03', days: [], expenses: [], journals: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeCloud() {
  const rows = new Map();
  const started = [];
  const failures = new Map();
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
  const failureFor = (ids) => {
    for (const id of [...ids, '*']) {
      const failure = failures.get(id);
      if (!failure) continue;
      if (failure.times !== Infinity) { failure.times -= 1; if (failure.times <= 0) failures.delete(id); }
      return failure;
    }
    return null;
  };
  const apply = (ids, run) => () => {
    const failure = failureFor(ids);
    if (failure) return { data: null, error: failure.error, status: failure.status ?? 400 };
    return run();
  };
  const table = {
    select: () => ({ order: () => request('select', () => ({ data: [...rows.values()], error: null, status: 200 })) }),
    upsert: (input) => {
      const list = Array.isArray(input) ? input : [input];
      const ids = list.map((row) => row.id);
      const label = `upsert:${ids.join(',')}`;
      const selected = (single) => request(label, apply(ids, () => {
        const saved = list.map(store);
        return { data: single ? saved[0] : saved, error: null, status: 200 };
      }));
      return {
        ...request(label, apply(ids, () => { list.forEach(store); return { error: null, status: 201 }; })),
        select: () => ({ ...selected(false), single: () => selected(true) })
      };
    },
    delete: () => ({ eq: (_column, id) => request(`delete:${id}`, apply([id], () => { rows.delete(id); return { error: null, status: 204 }; })) })
  };
  return {
    rows,
    started,
    from: () => table,
    fail(tripId, { error, status = 400, times = Infinity } = {}) { failures.set(tripId, { error, status, times }); },
    heal(tripId) { failures.delete(tripId); },
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

test('stops without coordinates stay null through a cloud save and reload', withCloud(async () => {
  const stops = [{ id: 's1', title: 'No pin', lat: null, lng: null }, { id: 's2', title: 'Equator', lat: 0, lng: 0 }];
  await saveTrip({ ...trip('trip-a', 'Coords'), days: [{ id: 'd1', stops }] }, session, []);
  const [loaded] = await loadTrips(session);
  assert.deepEqual(loaded.days[0].stops.map(({ lat, lng }) => [lat, lng]), [[null, null], [0, 0]]);
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

const rejection = { message: 'new row violates check constraint', code: '23514' };
const cloudRow = (id, title) => ({ id, owner_id: 'sync-user', title, destination: 'Lisbon', start_date: '2026-09-01', end_date: '2026-09-03', status: 'planning', style: 'Dengeli', pace: 'Rahat', cover_key: 'default', budget_total: 0, currency: 'EUR', plan: {}, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z' });

async function queueOffline(setOnline, ...trips) {
  setOnline(false);
  let list = [];
  for (const item of trips) list = (await saveTrip(item, session, list)).trips;
  setOnline(true);
  return list;
}

test('a change the server rejects moves aside and does not block later changes', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'Rejected'), trip('trip-b', 'Fine'));
  cloud.fail('trip-a', { error: rejection, status: 400 });

  assert.equal(await flushPendingTripChanges(session), 1);
  assert.deepEqual([...cloud.rows.keys()], ['trip-b']);
  assert.equal(pendingTripSyncCount(session), 0);
  assert.equal(failedTripSyncCount(session), 1);
}));

test('a rejected change stays visible after a cloud refresh', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'Offline title'), trip('trip-b', 'Fine'));
  cloud.fail('trip-a', { error: rejection, status: 400 });
  await flushPendingTripChanges(session);

  const loaded = await loadTrips(session);
  assert.deepEqual(loaded.map(({ id, title }) => [id, title]).sort(), [['trip-a', 'Offline title'], ['trip-b', 'Fine']]);
}));

test('saving a trip again clears its rejected change', withCloud(async ({ cloud, setOnline }) => {
  const list = await queueOffline(setOnline, trip('trip-a', 'Rejected once'));
  cloud.fail('trip-a', { error: rejection, status: 400, times: 1 });
  await flushPendingTripChanges(session);
  assert.equal(failedTripSyncCount(session), 1);

  await saveTrip(trip('trip-a', 'Fixed'), session, list);
  assert.equal(failedTripSyncCount(session), 0);
  assert.equal(cloud.rows.get('trip-a').title, 'Fixed');
}));

test('deleting a trip clears its rejected change', withCloud(async ({ cloud, setOnline }) => {
  const list = await queueOffline(setOnline, trip('trip-a', 'Rejected'));
  cloud.fail('trip-a', { error: rejection, status: 400, times: 1 });
  await flushPendingTripChanges(session);
  assert.equal(failedTripSyncCount(session), 1);

  await deleteTrip('trip-a', session, list);
  assert.equal(failedTripSyncCount(session), 0);
}));

test('a server outage keeps the change queued', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'A'));
  cloud.fail('trip-a', { error: { message: 'upstream unavailable' }, status: 503 });

  await assert.rejects(flushPendingTripChanges(session));
  assert.equal(pendingTripSyncCount(session), 1);
  assert.equal(failedTripSyncCount(session), 0);
  assert.equal(readSyncQueue(session.user.id)[0].attempts, 1);
}));

test('an expired session keeps the change queued', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'A'));
  cloud.fail('trip-a', { error: { message: 'JWT expired', code: 'PGRST301' }, status: 401 });

  await assert.rejects(flushPendingTripChanges(session));
  assert.equal(pendingTripSyncCount(session), 1);
  assert.equal(failedTripSyncCount(session), 0);
}));

test('a change that keeps failing is moved aside after five attempts', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'A'));
  cloud.fail('trip-a', { error: { message: 'upstream unavailable' }, status: 503 });

  for (let attempt = 1; attempt < 5; attempt += 1) {
    await assert.rejects(flushPendingTripChanges(session));
    assert.equal(pendingTripSyncCount(session), 1);
  }
  assert.equal(await flushPendingTripChanges(session), 0);
  assert.equal(pendingTripSyncCount(session), 0);
  assert.equal(failedTripSyncCount(session), 1);
}));

test('network failures never count as attempts', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'A'));
  cloud.fail('trip-a', { error: { message: 'Failed to fetch' }, status: 0 });

  for (let attempt = 0; attempt < 6; attempt += 1) await assert.rejects(flushPendingTripChanges(session));
  assert.equal(pendingTripSyncCount(session), 1);
  assert.equal(failedTripSyncCount(session), 0);
  assert.equal(readSyncQueue(session.user.id)[0].attempts, undefined);
}));

test('two devices: last write to reach the cloud wins per trip', withCloud(async ({ cloud, setOnline }) => {
  await queueOffline(setOnline, trip('trip-a', 'Laptop'));
  cloud.rows.set('trip-a', cloudRow('trip-a', 'Phone'));
  cloud.rows.set('trip-b', cloudRow('trip-b', 'Phone only'));

  await flushPendingTripChanges(session);
  assert.equal(cloud.rows.get('trip-a').title, 'Laptop');
  assert.equal(cloud.rows.get('trip-b').title, 'Phone only');

  cloud.rows.set('trip-a', cloudRow('trip-a', 'Phone again'));
  const loaded = await loadTrips(session);
  assert.equal(loaded.find((item) => item.id === 'trip-a').title, 'Phone again');
  assert.equal(loaded.find((item) => item.id === 'trip-b').title, 'Phone only');
}));

const storedGuestTrips = () => JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY));

test('an untouched example trip is not uploaded at sign-in', withCloud(async ({ cloud }) => {
  await loadTrips(null);
  assert.deepEqual(await migrateGuestTrips(session), []);
  assert.equal(cloud.rows.size, 0);
  assert.notEqual(localStorage.getItem(GUEST_STORAGE_KEY), null);
}));

test('an edited example trip is uploaded at sign-in', withCloud(async ({ cloud }) => {
  const trips = await loadTrips(null);
  await saveTrip({ ...trips[0], title: 'Roma, benim planım' }, null, trips);

  const migrated = await migrateGuestTrips(session);
  const [row] = [...cloud.rows.values()];
  assert.equal(cloud.rows.size, 1);
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(row.title, 'Roma, benim planım');
  assert.equal(row.plan.source, 'manual');
  assert.equal(migrated.length, 1);
  assert.equal(localStorage.getItem(GUEST_STORAGE_KEY), null);
}));

test('an example edited before this update is uploaded', withCloud(async ({ cloud }) => {
  const demo = createDemoTrip();
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify([{ ...demo, title: 'Eski düzenleme', updatedAt: new Date(Date.parse(demo.createdAt) + 86400000).toISOString() }]));

  await migrateGuestTrips(session);
  assert.deepEqual([...cloud.rows.values()].map((row) => row.title), ['Eski düzenleme']);
}));

test('a guest trip with a non-UUID id is uploaded under a new id', withCloud(async ({ cloud }) => {
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify([trip('guest-1', 'Elle eklenen')]));
  await migrateGuestTrips(session);
  assert.equal(cloud.rows.has('guest-1'), false);
  assert.deepEqual([...cloud.rows.values()].map((row) => row.title), ['Elle eklenen']);
}));

test('a retried migration does not duplicate the example', withCloud(async ({ cloud }) => {
  const trips = await loadTrips(null);
  await saveTrip({ ...trips[0], title: 'Roma, benim planım' }, null, trips);
  cloud.fail('*', { error: rejection, status: 400, times: 1 });

  await assert.rejects(migrateGuestTrips(session));
  const [{ id }] = storedGuestTrips();
  assert.equal(cloud.rows.size, 0);

  await migrateGuestTrips(session);
  assert.deepEqual([...cloud.rows.keys()], [id]);
  assert.equal(localStorage.getItem(GUEST_STORAGE_KEY), null);
}));

const hugeTrip = () => ({ ...trip('trip-big', 'Dev gezi'), journals: Array.from({ length: 100 }, (_, n) => ({ id: `j${n}`, title: 'J', body: 'x'.repeat(20000) })) });

test('an oversized plan is refused before any cloud request or queueing', withCloud(async ({ cloud, setOnline }) => {
  await assert.rejects(() => saveTrip(hugeTrip(), session, []), (error) => error.code === 'plan_too_large' && /^'Dev gezi' seyahati buluta kaydedilemeyecek kadar büyük/.test(error.message));
  assert.deepEqual(cloud.started, []);
  assert.equal(cloud.rows.size, 0);
  setOnline(false);
  await assert.rejects(() => saveTrip(hugeTrip(), session, []), (error) => error.code === 'plan_too_large');
  assert.equal(pendingTripSyncCount(session), 0);
  assert.deepEqual(readCloudCache('sync-user'), []);
}));

test('planSizeBytes equals the size of the plan toRow sends to the cloud', withCloud(async ({ cloud }) => {
  const sample = { ...trip('trip-a', 'Ölçüm'), note: 'Çay, kahve: "iki"', source: 'gemini', plannerMeta: { provider: 'x', verifiedPlaces: 2 }, days: [{ id: 'd1', stops: [{ id: 's1', title: 'A', lat: null, lng: 0 }] }] };
  await saveTrip(sample, session, []);
  const sent = cloud.rows.get('trip-a').plan;
  const oracle = JSON.stringify(sent).replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (_all, string, separator) => string || `${separator} `);
  assert.equal(planSizeBytes(sample), Buffer.byteLength(oracle, 'utf8'));
}));

test('guests can still save a large trip locally', withCloud(async ({ cloud }) => {
  const { trips } = await saveTrip(hugeTrip(), null, []);
  assert.equal(trips.length, 1);
  assert.deepEqual(cloud.started, []);
}));

test('migrating a guest trip that is too large to sync uploads nothing and keeps the guest copy', withCloud(async ({ cloud }) => {
  localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify([trip('00000000-0000-4000-8000-000000000001', 'Küçük'), { ...hugeTrip(), id: '00000000-0000-4000-8000-000000000002' }]));
  await assert.rejects(() => migrateGuestTrips(session), (error) => error.code === 'plan_too_large');
  assert.deepEqual(cloud.started, []);
  assert.equal(JSON.parse(localStorage.getItem(GUEST_STORAGE_KEY)).length, 2);
}));
