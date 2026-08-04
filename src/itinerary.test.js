import assert from 'node:assert/strict';
import test from 'node:test';
import { dayReadiness, googleDayRouteUrl, mealRole, moveStop, optimizeDay, shiftDay, tiktokSearchUrl } from './itinerary.js';

test('recognizes Turkish and explicit meal roles', () => {
  assert.equal(mealRole({ category: 'Öğle yemeği' }), 'lunch');
  assert.equal(mealRole({ mealRole: 'dinner', category: 'Restaurant' }), 'dinner');
});

test('requires a full pace-aware day and all meals', () => {
  const day = { stops: [{ mealRole: 'breakfast' }, { mealRole: 'lunch' }, { mealRole: 'dinner' }, {}, {}] };
  assert.equal(dayReadiness(day, 'Rahat').complete, true);
  assert.equal(dayReadiness(day, 'Yoğun').complete, false);
});

test('shifts a day from a selected stop', () => {
  const day = { stops: [{ id: 'a', time: '09:00' }, { id: 'b', time: '10:30' }] };
  assert.deepEqual(shiftDay(day, 15, 'b').stops.map((stop) => stop.time), ['09:00', '10:45']);
});

test('moves stops while keeping chronological time slots', () => {
  const day = { stops: [{ id: 'a', time: '09:00' }, { id: 'b', time: '10:00' }] };
  assert.deepEqual(moveStop(day, 'b', -1).stops, [{ id: 'b', time: '09:00' }, { id: 'a', time: '10:00' }]);
});

test('optimizer preserves meal anchors and orders located blocks', () => {
  const day = { stops: [
    { id: 'far', time: '09:00', lat: 0, lng: 2 },
    { id: 'near', time: '10:00', lat: 0, lng: 1 },
    { id: 'meal', time: '12:00', lat: 0, lng: 3, mealRole: 'lunch' },
    { id: 'after', time: '14:00', lat: 0, lng: 4 }
  ] };
  assert.equal(optimizeDay(day).stops[2].id, 'meal');
});

test('builds external discovery and full-day navigation urls', () => {
  assert.match(tiktokSearchUrl('kahve', 'Roma'), /tiktok\.com\/search/);
  assert.match(googleDayRouteUrl({ stops: [{ title: 'A' }, { title: 'B' }] }), /google\.com\/maps\/dir/);
});
