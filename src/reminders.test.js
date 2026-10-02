import assert from 'node:assert/strict';
import test from 'node:test';
import { orphanedReminderIds, reminderIdFor, reminderIdsForStops, reminderIdsForTrip, reminderIdsForTrips, reminderIdsOnUserChange } from './reminders.js';

const stop = (id, reminderAt = '') => ({ id, title: id, reminderAt });
const trip = (id, ...stops) => ({ id, days: [{ id: `${id}-d1`, stops: stops.slice(0, 1) }, { id: `${id}-d2`, stops: stops.slice(1) }] });

test('reminder ids are stable positive 31-bit integers', () => {
  const id = reminderIdFor('stop-1');
  assert.equal(id, reminderIdFor('stop-1'));
  assert.ok(Number.isInteger(id) && id > 0 && id <= 2_147_483_647);
  assert.notEqual(id, reminderIdFor('stop-2'));
});

test('only stops that have a reminder produce ids', () => {
  assert.deepEqual(reminderIdsForStops([stop('stop-alpha', '2026-09-01T10:00'), stop('stop-bravo-2'), { reminderAt: '2026-09-01T10:00' }]), [reminderIdFor('stop-alpha')]);
  assert.deepEqual(reminderIdsForStops(), []);
});

test('a deleted trip yields the reminders of every day', () => {
  const doomed = trip('t1', stop('stop-alpha', '2026-09-01T10:00'), stop('stop-bravo-2'), stop('stop-charlie-33', '2026-09-02T10:00'));
  assert.deepEqual(reminderIdsForTrip(doomed), [reminderIdFor('stop-alpha'), reminderIdFor('stop-charlie-33')]);
  assert.deepEqual(reminderIdsForTrip({ id: 'empty' }), []);
  assert.deepEqual(reminderIdsForTrip(null), []);
});

test('a refresh cancels reminders of removed trips, stops and cleared reminders only', () => {
  const before = [
    trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'), stop('stop-charlie-33', 'x')),
    trip('t2', stop('stop-delta-4444', 'x'), stop('stop-echo'))
  ];
  const after = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2'))];
  assert.deepEqual(orphanedReminderIds(before, after).sort((x, y) => x - y), [reminderIdFor('stop-bravo-2'), reminderIdFor('stop-charlie-33'), reminderIdFor('stop-delta-4444')].sort((x, y) => x - y));
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
  assert.deepEqual(ids.sort((x, y) => x - y), [reminderIdFor('stop-alpha'), reminderIdFor('stop-bravo-2'), reminderIdFor('stop-charlie-33')].sort((x, y) => x - y));
  assert.equal(ids.includes(reminderIdFor('stop-guest-1')), false);
});

test('a reminder whose stop is still shown after sign-out is not cancelled', () => {
  const account = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'))];
  const guest = [trip('t1-copy', stop('stop-alpha', 'x'))];
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: null, previousTrips: account, shownTrips: guest }), [reminderIdFor('stop-bravo-2')]);
});

test('switching accounts cancels everything the previous account scheduled', () => {
  const account = [trip('t1', stop('stop-alpha', 'x'), stop('stop-bravo-2', 'x'))];
  assert.deepEqual(reminderIdsOnUserChange({ previousUserId: 'user-a', userId: 'user-b', previousTrips: account }).sort((x, y) => x - y), [reminderIdFor('stop-alpha'), reminderIdFor('stop-bravo-2')].sort((x, y) => x - y));
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
  assert.deepEqual(reminderIdsForTrips(trips).sort(), ['a', 'c', 'e'].map(reminderIdFor).sort());
  assert.deepEqual(reminderIdsForTrips(), []);
  assert.deepEqual(reminderIdsForTrips([null, {}]), []);
});
