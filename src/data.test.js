import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoTrip, DEMO_TRIP_LEAD_DAYS } from './data.js';

const NOW = new Date(2026, 9, 2, 9, 30);

test('the example trip starts in the future relative to the injected clock', () => {
  const trip = createDemoTrip(NOW);
  assert.equal(trip.startDate, '2026-10-16');
  assert.ok(trip.startDate > '2026-10-02');
  assert.equal(DEMO_TRIP_LEAD_DAYS, 14);
});

test('the example trip keeps its four consecutive days and derives the end date from the start', () => {
  const trip = createDemoTrip(NOW);
  assert.deepEqual(trip.days.map((day) => day.date), ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
  assert.equal(trip.durationDays, 4);
  assert.equal(trip.endDate, '2026-10-19');
  assert.equal(trip.id, 'demo-rome');
  assert.equal(trip.source, 'demo');
});

test('example trip dates follow the clock across month and year boundaries', () => {
  const trip = createDemoTrip(new Date(2026, 11, 25, 23, 59));
  assert.deepEqual(trip.days.map((day) => day.date), ['2027-01-08', '2027-01-09', '2027-01-10', '2027-01-11']);
});

test('the example trip starts exactly the lead time after the local day it was created', () => {
  for (const now of [new Date(2026, 7, 16), new Date(2027, 1, 28, 0, 5), new Date(2028, 1, 29, 23, 55)]) {
    const trip = createDemoTrip(now);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    assert.equal(new Date(`${trip.startDate}T12:00:00`) - today, DEMO_TRIP_LEAD_DAYS * 86400000);
  }
});
