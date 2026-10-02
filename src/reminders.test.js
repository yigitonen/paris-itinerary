import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { legacyReminderIdFor, orphanedReminderIds, reminderIdFor, reminderIdsFor, reminderIdsForStops, reminderIdsForTrip, reminderIdsForTrips, reminderIdsOnUserChange } from './reminders.js';

const stop = (id, reminderAt = '') => ({ id, title: id, reminderAt });
// Every id a stop's reminder can be registered under: the current one and the legacy one.
const idsOf = (...stopIds) => stopIds.flatMap(reminderIdsFor);
const trip = (id, ...stops) => ({ id, days: [{ id: `${id}-d1`, stops: stops.slice(0, 1) }, { id: `${id}-d2`, stops: stops.slice(1) }] });

test('reminder ids are stable positive 31-bit integers', () => {
  const id = reminderIdFor('stop-1');
  assert.equal(id, reminderIdFor('stop-1'));
  assert.ok(Number.isInteger(id) && id > 0 && id <= 2_147_483_647);
  assert.notEqual(id, reminderIdFor('stop-2'));
});

test('ids of stops that differed only in the last bit of the legacy hash no longer collide', () => {
  assert.equal(legacyReminderIdFor('c'), legacyReminderIdFor('d'));
  assert.notEqual(reminderIdFor('c'), reminderIdFor('d'));
});

test('reminder ids are pinned so they stay stable across runs and releases', () => {
  assert.equal(reminderIdFor('c'), 1712073810);
  assert.equal(reminderIdFor('stop-1'), 504362699);
  assert.equal(reminderIdFor('00000000-0000-4000-8000-000000000000'), 1349533493);
  assert.equal(legacyReminderIdFor('stop-1'), 512743926);
});

test('20k random UUIDs get unique positive 31-bit ids', () => {
  const ids = new Set();
  for (let index = 0; index < 20_000; index += 1) {
    const id = reminderIdFor(randomUUID());
    assert.ok(Number.isInteger(id) && id > 0 && id <= 2_147_483_647);
    ids.add(id);
  }
  assert.equal(ids.size, 20_000);
});

test('an empty or non-string value still yields a valid id', () => {
  for (const value of ['', undefined, null, 42, 'ünï-😀']) {
    const id = reminderIdFor(value);
    assert.ok(Number.isInteger(id) && id > 0 && id <= 2_147_483_647);
  }
});

test('reminderIdsFor lists the current id first and the legacy id, each once', () => {
  assert.deepEqual(reminderIdsFor('stop-1'), [reminderIdFor('stop-1'), legacyReminderIdFor('stop-1')]);
  assert.deepEqual(reminderIdsFor('c'), [reminderIdFor('c'), 158]);
  const same = reminderIdsFor('stop-1');
  assert.equal(new Set(same).size, same.length);
});

test('only stops that have a reminder produce ids', () => {
  assert.deepEqual(reminderIdsForStops([stop('stop-alpha', '2026-09-01T10:00'), stop('stop-bravo-2'), { reminderAt: '2026-09-01T10:00' }]), reminderIdsFor('stop-alpha'));
  assert.deepEqual(reminderIdsForStops(), []);
});

test('a deleted trip yields the reminders of every day', () => {
  const doomed = trip('t1', stop('stop-alpha', '2026-09-01T10:00'), stop('stop-bravo-2'), stop('stop-charlie-33', '2026-09-02T10:00'));
  assert.deepEqual(reminderIdsForTrip(doomed), idsOf('stop-alpha', 'stop-charlie-33'));
  assert.deepEqual(reminderIdsForTrip({ id: 'empty' }), []);
  assert.deepEqual(reminderIdsForTrip(null), []);
});

test('a refresh cancels reminders of removed trips, stops and cleared reminders only', () => {
  const before = [
    trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'), stop('stop-charlie-33', 'x')),
    trip('t2', stop('stop-delta-4444', 'x'), stop('stop-echo'))
  ];
  const after = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2'))];
  assert.deepEqual(orphanedReminderIds(before, after).sort((x, y) => x - y), idsOf('stop-bravo-2', 'stop-charlie-33', 'stop-delta-4444').sort((x, y) => x - y));
  assert.deepEqual(orphanedReminderIds(before, before), []);
  assert.deepEqual(orphanedReminderIds([], before), []);
  assert.deepEqual(orphanedReminderIds(undefined, undefined), []);
});

test('a stop that moved to another day or trip keeps its reminder', () => {
  const before = [trip('t1', stop('stop-alpha', 'x'))];
  const after = [trip('t2', stop('z'), stop('stop-alpha', 'x'))];
  assert.deepEqual(orphanedReminderIds(before, after), []);
});

test('signing out cancels the account reminders but keeps those of guest trips that remain', () => {
  const account = [trip('cloud-1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x')), trip('cloud-2', stop('stop-charlie-33', 'x'))];
  const guest = [trip('local-1', stop('stop-guest-1', 'x'))];
  const ids = reminderIdsOnUserChange({ previousUserId: 'user-a', userId: null, previousTrips: account, shownTrips: guest });
  assert.deepEqual(ids.sort((x, y) => x - y), idsOf('stop-alpha', 'stop-bravo-2', 'stop-charlie-33').sort((x, y) => x - y));
  assert.equal(ids.some((id) => reminderIdsFor('stop-guest-1').includes(id)), false);
});

test('a reminder whose stop is still shown after sign-out is not cancelled', () => {
  const account = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'))];
  const guest = [trip('t1-copy', stop('stop-alpha', 'x'))];
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: null, previousTrips: account, shownTrips: guest }), reminderIdsFor('stop-bravo-2'));
});

test('switching accounts cancels everything the previous account scheduled', () => {
  const account = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'))];
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: 'user-b', previousTrips: account }).sort((x, y) => x - y), idsOf('stop-alpha', 'stop-bravo-2').sort((x, y) => x - y));
});

test('a guest or unchanged user cancels nothing', () => {
  const trips = [trip('t1', stop('stop-alpha', 'x'))];
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: null, userId: 'user-a', previousTrips: trips }), []);
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: undefined, userId: null, previousTrips: trips }), []);
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: 'user-a', previousTrips: trips }), []);
  assert.deepEqual(reminderIdsOnUserChange(), []);
});

test('account deletion collects every reminder of every trip once', () => {
  const stop = (id, reminderAt) => ({ id, reminderAt });
  const trips = [
    { days: [{ stops: [stop('a', '2026-10-05T09:00'), stop('b')] }, { stops: [stop('c', '2026-10-06T09:00')] }] },
    { days: [{ stops: [stop('a', '2026-10-05T09:00'), stop('e', '2026-10-07T09:00')] }] },
    { days: [] }
  ];
  assert.deepEqual(reminderIdsForTrips(trips).sort(), idsOf('a', 'c', 'e').sort());
  assert.deepEqual(reminderIdsForTrips(), []);
  assert.deepEqual(reminderIdsForTrips([null, {}]), []);
});

test('cancellation helpers include the legacy ids of reminders scheduled by older versions', () => {
  const legacy = legacyReminderIdFor('stop-alpha');
  const doomed = trip('t1', stop('stop-alpha', 'x'));
  assert.ok(reminderIdsForStops(doomed.days[0].stops).includes(legacy));
  assert.ok(reminderIdsForTrip(doomed).includes(legacy));
  assert.ok(reminderIdsForTrips([doomed]).includes(legacy));
  assert.ok(orphanedReminderIds([doomed], []).includes(legacy));
  assert.ok(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: null, previousTrips: [doomed] }).includes(legacy));
  assert.ok(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: null, previousTrips: [doomed] }).includes(reminderIdFor('stop-alpha')));
});

test('cancelled ids are deduplicated when stops share a legacy id', () => {
  const ids = reminderIdsForTrips([trip('t1', stop('c', 'x'), stop('d', 'x'))]);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice().sort((x, y) => x - y), [158, reminderIdFor('c'), reminderIdFor('d')].sort((x, y) => x - y));
});
