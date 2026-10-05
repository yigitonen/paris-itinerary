import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualTrip } from './data.js';
import {
  BACKUP_MAX_BYTES,
  BACKUP_MAX_TRIPS,
  BackupError,
  backupErrorMessage,
  normalizeBackupTrip,
  parseBackup,
  serializeBackup,
  serializeTrip
} from './backup.js';

const counter = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const raw = (extra = {}) => ({
  destination: 'Roma',
  startDate: '2026-08-12',
  endDate: '2026-08-13',
  days: [{ id: 'day-1', date: '2026-08-12', title: 'Gün', stops: [{ id: 'stop-1', title: 'Pantheon', time: '10:00' }] }],
  ...extra
});
const normalize = (value) => normalizeBackupTrip(value, { makeId: counter() });
const rejects = (fn, code) => assert.throws(fn, (error) => error instanceof BackupError && error.code === code, `expected ${code}`);
const withStop = (stop) => raw({ days: [{ id: 'day-1', date: '2026-08-12', title: 'Gün', stops: [{ id: 'stop-1', title: 'Pantheon', time: '10:00', ...stop }] }] });
const firstStop = (trip) => trip.days[0].stops[0];

function manualFixture() {
  const trip = createManualTrip({ destination: 'Lizbon', startDate: '2026-09-10', days: 3, style: 'Yeme içme', pace: 'Dengeli', note: 'Tramvay\nve kahve' });
  trip.budgetTotal = 900;
  trip.country = 'Portekiz';
  trip.days[0].stops = [
    {
      id: crypto.randomUUID(), title: 'Pastéis de Belém', time: '09:30', category: 'Kahvaltı', address: 'Rua de Belém 84', notes: 'Sabah erken git.\nSıra uzun olur.',
      bookingStatus: 'needed', confirmation: 'ABC123', reminderAt: '2026-09-10T08:00', duration: '', mealRole: 'Breakfast', placeId: 'ChIJ-example',
      lat: 38.6975, lng: -9.2033, provider: 'google', googleMapsUrl: 'https://maps.google.com/?cid=123', mapsSourceUrl: 'https://maps.google.com/?cid=123',
      rating: 4.6, reviewCount: 120, verified: true
    },
    {
      id: crypto.randomUUID(), title: 'Elle eklenen durak', time: '12:00', category: 'Diğer', address: '', notes: '', bookingStatus: 'none', confirmation: '', reminderAt: '', duration: '',
      mealRole: 'None', placeId: '', lat: null, lng: null, provider: '', googleMapsUrl: '', mapsSourceUrl: '', rating: null, reviewCount: null, verified: false
    }
  ];
  trip.expenses = [{ id: crypto.randomUUID(), title: 'Tramvay', category: 'Diğer', amount: 12.5, currency: 'EUR', createdAt: '2026-09-10T10:00:00.000Z' }];
  trip.journals = [{ id: crypto.randomUUID(), title: 'İlk akşam', body: 'Alfama çok güzeldi.\nİkinci satır.', createdAt: '2026-09-10T20:00:00.000Z' }];
  return trip;
}

function geminiFixture() {
  const stop = (n, extra = {}) => ({
    id: `00000000-0000-4000-8000-0000000000${n}`, time: '10:00', title: `Mekan ${n}`, query: `Mekan ${n} Paris`, category: 'Durak', duration: '1 saat', notes: 'Not', why: 'Neden burada', travelerNote: 'Ortak not',
    importance: 'must-see', mealRole: 'None', address: 'Paris', lat: 48.85, lng: 2.35, placeId: '', rating: null, reviewCount: null, verified: true,
    mapsSourceName: `Mekan ${n}`, mapsSourceUrl: 'https://maps.google.com/?cid=9', bookingStatus: 'none', provider: '', googleMapsUrl: '', ...extra
  });
  return {
    id: '11111111-1111-4111-8111-111111111111', title: 'Paris', destination: 'Paris', country: 'Fransa', startDate: '2026-10-05', endDate: '2026-10-06', durationDays: 2,
    status: 'planning', style: 'Yeme içme', pace: 'Rahat', note: '', coverKey: 'paris', budgetTotal: 0, currency: 'EUR', source: 'gemini', summary: 'Kısa özet',
    researchSummary: 'Araştırıldı.',
    researchSources: [{ title: 'Louvre', url: 'https://maps.google.com/?cid=1', provider: 'Google Maps' }],
    plannerMeta: {
      provider: 'gemini-3.1-flash-lite', researched: true, verifiedPlaces: 2, totalPlaces: 2, stopsPerDay: 1, mealsPerDay: 3, routeOptimized: true, routeSequenced: true,
      routeMethod: 'Google Maps grounding plus coordinate ordering', coordinatePlaces: 2, coordinateOptimizedDays: 1, timeSensitiveDetailsNeedRecheck: true
    },
    savedPlaces: [{ id: 'saved-1', name: 'Café', address: 'Rue 1', lat: 48.1, lng: 2.1, provider: 'google', googleMapsUrl: 'https://maps.google.com/?cid=2', primaryType: 'saved_place' }],
    days: [
      { id: '22222222-2222-4222-8222-222222222221', date: '2026-10-05', title: '1. gün', theme: 'Klasikler', stops: [stop(1), stop(2, { time: '12:30', mealRole: 'Lunch', importance: 'local' })] },
      { id: '22222222-2222-4222-8222-222222222222', date: '2026-10-06', title: '2. gün', theme: '', stops: [] }
    ],
    expenses: [], journals: [], createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:05:00.000Z'
  };
}

test('a backup round-trips without losing data', () => {
  const trips = [manualFixture(), geminiFixture()];
  const { trips: parsed } = parseBackup(serializeBackup(trips), { makeId: counter() });
  assert.deepEqual(parsed, trips);
});

test('normalizing twice changes nothing', () => {
  const makeId = counter();
  const dirty = raw({ id: 'bad id', currency: 'usd', budgetTotal: '1200', days: [{ title: 'Gün', stops: [{ title: ' Pantheon ', time: '25:00', id: '<x>' }] }] });
  const once = normalizeBackupTrip(dirty, { makeId });
  assert.deepEqual(normalizeBackupTrip(once, { makeId }), once);
  for (const trip of [manualFixture(), geminiFixture()]) {
    const first = normalizeBackupTrip(trip, { makeId });
    assert.deepEqual(normalizeBackupTrip(first, { makeId }), first);
  }
});

test('a single-trip export file is accepted', () => {
  const { trips } = parseBackup(serializeTrip(geminiFixture()), { makeId: counter() });
  assert.equal(trips.length, 1);
  assert.equal(trips[0].destination, 'Paris');
  assert.equal(serializeTrip({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

test('a backup file wraps trips with a version and export time', () => {
  const file = JSON.parse(serializeBackup([geminiFixture()], { exportedAt: new Date('2026-10-01T10:00:00Z') }));
  assert.equal(file.version, 1);
  assert.equal(file.exportedAt, '2026-10-01T10:00:00.000Z');
  assert.equal(file.trips.length, 1);
  assert.equal(parseBackup(JSON.stringify({ trips: [raw()] }), { makeId: counter() }).trips.length, 1);
});

test('oversized input is rejected before parsing', () => {
  rejects(() => parseBackup('x'.repeat(BACKUP_MAX_BYTES + 1)), 'too_large');
  rejects(() => parseBackup('ç'.repeat(Math.ceil(BACKUP_MAX_BYTES / 2) + 1)), 'too_large');
});

test('files that are not backups are rejected', () => {
  rejects(() => parseBackup('nope'), 'invalid_json');
  for (const text of ['{}', '[]', '{"trips":[]}', '{"trips":"x"}', 'null', '5', '"x"']) rejects(() => parseBackup(text), 'invalid_format');
});

test('a trip without usable data is invalid', () => {
  const bad = [
    raw({ destination: '' }), raw({ destination: 7 }), raw({ destination: undefined }),
    raw({ startDate: '2026-02-30' }), raw({ startDate: 'tomorrow' }), raw({ endDate: 'tomorrow' }),
    raw({ startDate: '2026-08-14' }), raw({ endDate: '2028-08-12' }),
    raw({ days: [] }), raw({ days: 'x' }), raw({ days: Array.from({ length: 61 }, () => ({ title: 'x', stops: [] })) }),
    withStop({ title: '' }), raw({ expenses: [{ title: 'x', amount: 'abc' }] }), raw({ expenses: [{ title: '', amount: 1 }] }), raw({ expenses: [{ title: 'x', amount: -1 }] }),
    raw({ journals: [{ title: '', body: 'x' }] })
  ];
  for (const trip of bad) rejects(() => normalize(trip), 'invalid_trip');
  rejects(() => normalize(null), 'invalid_trip');
  rejects(() => normalize('x'), 'invalid_trip');
});

test('one bad trip rejects the whole file', () => {
  const text = JSON.stringify({ trips: [raw(), raw({ destination: '' }), raw()] });
  assert.throws(() => parseBackup(text, { makeId: counter() }), (error) => error.code === 'invalid_trip' && error.index === 1);
});

test('ids are checked and regenerated', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const trip = normalize(raw({
    id: evil,
    days: [{ id: evil, title: 'Gün', stops: [{ id: evil, title: 'Pantheon' }, { id: 'ok_stop-1', title: 'Forum' }] }],
    expenses: [{ id: evil, title: 'Bilet', amount: 5 }],
    journals: [{ id: evil, title: 'Not' }],
    savedPlaces: [{ id: evil, name: 'Yer' }]
  }));
  assert.match(trip.id, UUID);
  assert.doesNotMatch(trip.days[0].id, /[<>"]/);
  assert.doesNotMatch(trip.days[0].stops[0].id, /[<>"]/);
  assert.equal(trip.days[0].stops[1].id, 'ok_stop-1');
  for (const id of [trip.expenses[0].id, trip.journals[0].id, trip.savedPlaces[0].id]) assert.match(id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(normalize(raw({ id: 'ABCDEF01-2345-4678-8ABC-ABCDEF012345' })).id, 'abcdef01-2345-4678-8abc-abcdef012345');

  const one = geminiFixture();
  const { trips } = parseBackup(JSON.stringify({ trips: [one, one, one] }), { makeId: counter() });
  assert.equal(trips[0].id, one.id);
  assert.equal(new Set(trips.map((item) => item.id)).size, 3);
  for (const item of trips) assert.match(item.id, UUID);
});

test('currency, cover, budget and rating are coerced to safe values', () => {
  assert.equal(normalize(raw({ currency: 'EUR"><script>' })).currency, 'EUR');
  assert.equal(normalize(raw({ currency: 'usd' })).currency, 'USD');
  assert.equal(normalize(raw({ currency: 5 })).currency, 'EUR');
  for (const key of ['constructor', '__proto__', 'toString', 'nope', 3]) assert.equal(normalize(raw({ coverKey: key })).coverKey, 'default');
  assert.equal(normalize(raw({ coverKey: 'paris' })).coverKey, 'paris');
  assert.equal(normalize(raw({ budgetTotal: '1200' })).budgetTotal, 1200);
  assert.equal(normalize(raw({ budgetTotal: -5 })).budgetTotal, 0);
  assert.equal(normalize(raw({ budgetTotal: 'abc' })).budgetTotal, 0);
  assert.equal(normalize(raw({ budgetTotal: 1e12 })).budgetTotal, 0);
  assert.equal(firstStop(normalize(withStop({ rating: 7 }))).rating, null);
  assert.equal(firstStop(normalize(withStop({ rating: '4.5' }))).rating, 4.5);
  assert.equal(firstStop(normalize(withStop({ reviewCount: -1 }))).reviewCount, null);
  assert.equal(normalize(raw({ expenses: [{ title: 'x', amount: '12.5', currency: 'try' }] })).expenses[0].currency, 'TRY');
  assert.equal(normalize(raw({ currency: 'USD', expenses: [{ title: 'x', amount: 1, currency: '<b>' }] })).expenses[0].currency, 'USD');
});

test('unsafe links are removed', () => {
  const stop = firstStop(normalize(withStop({ googleMapsUrl: 'javascript:alert(1)', mapsSourceUrl: 'data:text/html,<script>' })));
  assert.equal(stop.googleMapsUrl, '');
  assert.equal(stop.mapsSourceUrl, '');
  assert.equal(firstStop(normalize(withStop({ googleMapsUrl: 'https://maps.google.com/?cid=1' }))).googleMapsUrl, 'https://maps.google.com/?cid=1');
  const trip = normalize(raw({
    researchSources: [
      { title: 'Kötü', url: 'javascript:alert(1)', provider: 'x' },
      { title: 'Data', url: 'data:text/html,hi' },
      { title: 'İyi', url: 'https://example.com/a', provider: 'Web' },
      'not-an-object'
    ],
    savedPlaces: [{ id: 'a', name: 'Yer', googleMapsUrl: 'javascript:1' }]
  }));
  assert.deepEqual(trip.researchSources, [{ title: 'İyi', url: 'https://example.com/a', provider: 'Web' }]);
  assert.equal(trip.savedPlaces[0].googleMapsUrl, '');
});

test('over-long and control-character text is capped and cleaned', () => {
  const trip = normalize(raw({
    destination: `  ${'R'.repeat(300)}  `, title: 'T'.repeat(300), note: 'n'.repeat(5000), summary: 's'.repeat(5000), researchSummary: 'r'.repeat(5000), style: 'y'.repeat(100),
    days: [{ title: 'g'.repeat(500), theme: 't'.repeat(500), stops: [{ title: 'p'.repeat(500), notes: 'n'.repeat(5000), why: 'w'.repeat(5000), travelerNote: 'x'.repeat(5000), address: 'a'.repeat(1000) }] }],
    journals: [{ title: 'j'.repeat(500), body: 'b'.repeat(50000) }]
  }));
  assert.equal(trip.destination.length, 100);
  assert.equal(trip.title.length, 100);
  assert.equal(trip.note.length, 600);
  assert.equal(trip.summary.length, 600);
  assert.equal(trip.researchSummary.length, 1000);
  assert.equal(trip.style.length, 40);
  assert.equal(trip.days[0].title.length, 100);
  assert.equal(trip.days[0].theme.length, 180);
  const stop = firstStop(trip);
  assert.deepEqual([stop.title.length, stop.notes.length, stop.why.length, stop.travelerNote.length, stop.address.length], [120, 1000, 400, 400, 240]);
  assert.equal(trip.journals[0].title.length, 160);
  assert.equal(trip.journals[0].body.length, 20000);

  const clean = normalize(raw({ destination: 'Ro\u0000ma\u0007', note: 'a\r\nb\u0000c\td' }));
  assert.equal(clean.destination, 'Ro ma');
  assert.equal(clean.note, 'a\nbc\td');
});

test('coordinates stay null instead of becoming zero', () => {
  const read = (lat, lng) => firstStop(normalize(withStop({ lat, lng })));
  assert.deepEqual([read(null, null).lat, read(null, null).lng], [null, null]);
  assert.deepEqual([read('', '').lat, read('', '').lng], [null, null]);
  assert.deepEqual([read('41.9', '12.5').lat, read('41.9', '12.5').lng], [41.9, 12.5]);
  assert.deepEqual([read(200, 12.5).lat, read(200, 12.5).lng], [null, null]);
  assert.deepEqual([read(41.9, 181).lat, read(41.9, 181).lng], [null, null]);
  assert.deepEqual([read(41.9, null).lat, read(41.9, null).lng], [null, null]);
  assert.deepEqual([read('abc', 12).lat, read('abc', 12).lng], [null, null]);
  assert.deepEqual([read(0, 0).lat, read(0, 0).lng], [0, 0]);
  const place = normalize(raw({ savedPlaces: [{ id: 'a', name: 'Yer', lat: 95, lng: 10 }] })).savedPlaces[0];
  assert.deepEqual([place.lat, place.lng], [null, null]);
});

test('prototype keys and unknown fields are dropped', () => {
  const text = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"trips":[' + JSON.stringify(raw({ evil: '<script>', extra: { a: 1 } })).slice(0, -1) + ',"__proto__":{"polluted":true}}]}';
  const { trips } = parseBackup(text, { makeId: counter() });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(trips[0], 'evil'), false);
  assert.equal(Object.hasOwn(trips[0], 'extra'), false);
  assert.equal(Object.hasOwn(trips[0], '__proto__'), false);
  const stop = firstStop(normalizeBackupTrip(withStop({ hack: 1, onclick: 'x' }), { makeId: counter() }));
  assert.equal(Object.hasOwn(stop, 'hack'), false);
  assert.equal(Object.hasOwn(stop, 'onclick'), false);
});

test('the example trip id and source are replaced on import', () => {
  const trip = normalize(raw({ id: 'demo-rome', source: 'demo', demoEdited: true }));
  assert.match(trip.id, UUID);
  assert.equal(trip.source, 'manual');
  assert.equal(Object.hasOwn(trip, 'demoEdited'), false);
  assert.equal(normalize(raw({ source: 'gemini' })).source, 'gemini');
  assert.equal(normalize(raw({ source: 'whatever' })).source, 'manual');
});

test('more than 200 trips are rejected', () => {
  const trips = Array.from({ length: BACKUP_MAX_TRIPS + 1 }, () => raw());
  rejects(() => parseBackup(JSON.stringify({ trips })), 'too_many');
  assert.equal(parseBackup(JSON.stringify({ trips: trips.slice(0, BACKUP_MAX_TRIPS) }), { makeId: counter() }).trips.length, BACKUP_MAX_TRIPS);
});

test('invalid enum values fall back to defaults', () => {
  const trip = normalize(raw({ status: 'bogus', style: '', pace: 5, title: '' }));
  assert.deepEqual([trip.status, trip.style, trip.pace, trip.title], ['planning', 'Dengeli', 'Rahat', 'Roma']);
  assert.equal(normalize(raw({ status: 'upcoming' })).status, 'upcoming');
  const stop = firstStop(normalize(withStop({ importance: 'huge', mealRole: 'Brunch', bookingStatus: 'maybe', provider: 'bing', time: '25:99' })));
  assert.equal(Object.hasOwn(stop, 'importance'), false);
  assert.equal(Object.hasOwn(stop, 'mealRole'), false);
  assert.equal(stop.bookingStatus, 'none');
  assert.equal(stop.provider, '');
  assert.equal(stop.time, '');
  assert.equal(firstStop(normalize(withStop({ provider: 'osm' }))).provider, 'saved');
  assert.equal(firstStop(normalize(withStop({ provider: 'google', importance: 'local', mealRole: 'Dinner', bookingStatus: 'booked' }))).importance, 'local');
});

test('dates are recomputed and checked', () => {
  const trip = normalize(raw({ durationDays: 99, endDate: '2026-08-15', days: [{ title: 'x' }, { date: 'nope', title: 'y' }] }));
  assert.equal(trip.durationDays, 4);
  assert.equal(trip.days[0].date, '2026-08-12');
  assert.equal(trip.days[1].date, '2026-08-13');
  assert.equal(trip.days[0].title, 'x');
  assert.equal(normalize(raw({ days: [{ stops: [] }] })).days[0].title, '1. gün');
  const stamped = normalize(raw({ createdAt: 'yesterday', updatedAt: '2026-10-01T09:00:00.123456+00:00' }));
  assert.ok(!Number.isNaN(Date.parse(stamped.createdAt)));
  assert.equal(stamped.updatedAt, '2026-10-01T09:00:00.123456+00:00');
  assert.equal(normalize(raw({ expenses: [{ title: 'x', amount: 1, createdAt: 'x' }] })).expenses.length, 1);
});

test('travel legs, reminders and verified flags are validated', () => {
  const stop = firstStop(normalize(withStop({ travelFromPreviousMinutes: '12', travelFromPreviousKm: -1, reminderAt: 'not a date', verified: 'yes' })));
  assert.equal(stop.travelFromPreviousMinutes, 12);
  assert.equal(Object.hasOwn(stop, 'travelFromPreviousKm'), false);
  assert.equal(stop.reminderAt, '');
  assert.equal(stop.verified, false);
  assert.equal(firstStop(normalize(withStop({ reminderAt: '2026-08-12T09:00' }))).reminderAt, '2026-08-12T09:00');
});

test('plannerMeta keeps only known typed fields', () => {
  const trip = normalize(raw({ plannerMeta: { provider: 'gemini', researched: 'yes', verifiedPlaces: 5000, totalPlaces: '7', evil: '<x>', routeMethod: 'm'.repeat(500) } }));
  assert.equal(trip.plannerMeta.provider, 'gemini');
  assert.equal(trip.plannerMeta.researched, false);
  assert.equal(trip.plannerMeta.verifiedPlaces, 0);
  assert.equal(trip.plannerMeta.totalPlaces, 7);
  assert.equal(trip.plannerMeta.routeMethod.length, 120);
  assert.equal(Object.hasOwn(trip.plannerMeta, 'evil'), false);
  assert.equal(normalize(raw({ plannerMeta: 'x' })).plannerMeta, null);
  assert.equal(normalize(raw({ plannerMeta: null })).plannerMeta, null);
  assert.equal(Object.hasOwn(normalize(raw()), 'plannerMeta'), false);
});

test('backup errors have Turkish messages', () => {
  assert.equal(backupErrorMessage(new BackupError('too_large')), 'Yedek dosyası çok büyük (en fazla 5 MB).');
  assert.equal(backupErrorMessage(new BackupError('too_many')), 'Bir yedekte en fazla 200 seyahat olabilir.');
  for (const error of [new BackupError('invalid_json'), new BackupError('invalid_trip'), new Error('x'), null]) assert.equal(backupErrorMessage(error), 'Bu dosya geçerli bir Roamly yedeği değil.');
});

test('a trip too large to save to the cloud rejects the import with its title and index', () => {
  const journals = (count) => Array.from({ length: count }, (_, n) => ({ id: `j${n}`, title: `J${n}`, body: 'x'.repeat(20000) }));
  const text = (count) => JSON.stringify({ trips: [raw(), raw({ title: 'Dev gezi', journals: journals(count) })] });
  assert.equal(parseBackup(text(90), { makeId: counter() }).trips.length, 2);
  assert.ok(text(120).length < BACKUP_MAX_BYTES);
  assert.throws(() => parseBackup(text(120), { makeId: counter() }), (error) => error instanceof BackupError && error.code === 'trip_too_large' && error.index === 1 && error.title === 'Dev gezi');
});

test('the too-large backup message names the trip', () => {
  const message = backupErrorMessage(new BackupError('trip_too_large', 'x', { title: 'Dev gezi' }));
  assert.match(message, /^'Dev gezi' seyahati buluta kaydedilemeyecek kadar büyük\./);
  assert.match(message, /hiçbir seyahat içe aktarılmadı/);
});
