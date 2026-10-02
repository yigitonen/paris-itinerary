import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteTrip, loadTrips, saveTrip } from './repository.js';
import { GUEST_STORAGE_KEY } from './config.js';

function withGuestStorage(run) {
  return async () => {
    const values = new Map();
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key)
    };
    try {
      await run(values);
    } finally {
      delete globalThis.localStorage;
    }
  };
}

test('a first guest visit starts with the example trip', withGuestStorage(async () => {
  const trips = await loadTrips(null);
  assert.deepEqual(trips.map((trip) => trip.id), ['demo-rome']);
}));

test('guest stops without coordinates stay null after a reload', withGuestStorage(async () => {
  const [demo] = await loadTrips(null);
  const stop = { id: 'no-pin', time: '10:00', title: 'Kahve', lat: null, lng: null };
  await saveTrip({ ...demo, days: [{ ...demo.days[0], stops: [stop] }] }, null, [demo]);
  const [reloaded] = await loadTrips(null);
  assert.deepEqual([reloaded.days[0].stops[0].lat, reloaded.days[0].stops[0].lng], [null, null]);
}));

test('guest edits to the example trip survive a reload', withGuestStorage(async () => {
  const [demo] = await loadTrips(null);
  const edited = {
    ...demo,
    title: 'Roma, benim planım',
    journals: [{ id: 'journal-1', title: 'İlk akşam', body: 'Trastevere çok güzeldi.', createdAt: '2026-08-12T20:00:00.000Z' }]
  };
  await saveTrip(edited, null, [demo]);

  const [reloaded] = await loadTrips(null);
  assert.equal(reloaded.id, 'demo-rome');
  assert.equal(reloaded.title, 'Roma, benim planım');
  assert.equal(reloaded.journals.length, 1);
  assert.deepEqual(reloaded.days[0].stops.map((stop) => stop.id), demo.days[0].stops.map((stop) => stop.id));
}));

test('deleting the last guest trip stays empty after a reload', withGuestStorage(async (values) => {
  const trips = await loadTrips(null);
  const remaining = await deleteTrip('demo-rome', null, trips);
  assert.deepEqual(remaining, []);

  assert.deepEqual(await loadTrips(null), []);
  assert.equal(values.get(GUEST_STORAGE_KEY), '[]');
}));
