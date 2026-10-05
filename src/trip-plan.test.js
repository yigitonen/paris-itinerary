import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanFits, buildPlan, isPlanTooLarge, jsonbText, planSizeBytes, TRIP_PLAN_MAX_BYTES, TripTooLargeError } from './trip-plan.js';

// Independent oracle: take JSON.stringify output and add the space jsonb_out puts after ':' and ',' outside strings.
function jsonbFromCompact(compact) {
  let out = '';
  let inString = false;
  for (let i = 0; i < compact.length; i += 1) {
    const char = compact[i];
    out += char;
    if (inString) {
      if (char === '\\') out += compact[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === ',' || char === ':') out += ' ';
  }
  return out;
}

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const tripWithJournal = (body) => ({ id: 't', title: 'Büyük', destination: 'Roma', startDate: '2026-08-12', endDate: '2026-08-13', days: [], expenses: [], journals: [{ id: 'j', title: 'x', body }] });
const sizeWith = (length) => planSizeBytes(tripWithJournal('x'.repeat(length)));

test('the shared limit sits below the database cap of 2,000,000 bytes', () => {
  assert.ok(TRIP_PLAN_MAX_BYTES < 2_000_000);
  assert.ok(TRIP_PLAN_MAX_BYTES >= 1_800_000);
});

test('planSizeBytes measures jsonb text, which is larger than compact JSON', () => {
  const trip = {
    ...tripWithJournal('Çay, kahve: "iki" \\ yeni\nsatır 🙂'),
    note: 'not', plannerMeta: { provider: 'gemini', routeOptimized: true, verifiedPlaces: 3 }, savedPlaces: [{ id: 'p', name: 'Café', lat: 0, lng: -9.2 }],
    days: [{ id: 'd1', title: '1. gün', stops: [{ id: 's1', title: 'A', lat: null }, { id: 's2', title: 'B', notes: undefined }] }, { id: 'd2', stops: [] }]
  };
  const plan = buildPlan(trip);
  const compact = JSON.stringify(plan);
  assert.equal(jsonbText(plan), jsonbFromCompact(compact));
  assert.equal(planSizeBytes(trip), bytes(jsonbFromCompact(compact)));
  assert.ok(planSizeBytes(trip) > bytes(compact));
});

test('planSizeBytes measures the same plan that the cloud row carries', () => {
  const trip = { ...tripWithJournal('abc'), source: 'gemini', summary: 'Özet', researchSources: [{ title: 'T', url: 'https://example.com' }] };
  assert.deepEqual(buildPlan({ id: 'x' }), { source: 'manual', note: '', summary: '', researchSummary: '', researchSources: [], plannerMeta: null, savedPlaces: [], days: [], expenses: [], journals: [] });
  assert.equal(planSizeBytes(trip), bytes(jsonbFromCompact(JSON.stringify(buildPlan(trip)))));
});

test('a plan exactly at the limit passes and one byte over fails', () => {
  const base = sizeWith(0);
  const atLimit = TRIP_PLAN_MAX_BYTES - base;
  assert.equal(sizeWith(atLimit), TRIP_PLAN_MAX_BYTES);
  assert.equal(isPlanTooLarge(tripWithJournal('x'.repeat(atLimit))), false);
  assert.doesNotThrow(() => assertPlanFits(tripWithJournal('x'.repeat(atLimit))));
  assert.equal(isPlanTooLarge(tripWithJournal('x'.repeat(atLimit + 1))), true);
  assert.throws(() => assertPlanFits(tripWithJournal('x'.repeat(atLimit + 1))), (error) => error instanceof TripTooLargeError && error.code === 'plan_too_large');
});

test('multi-byte text counts in UTF-8 bytes, not characters', () => {
  assert.equal(sizeWith(0) + 2 * 10, planSizeBytes(tripWithJournal('ç'.repeat(10))));
});

test('the too-large message is Turkish and names the trip', () => {
  const error = new TripTooLargeError({ title: 'Roma', destination: 'Roma' });
  assert.match(error.message, /^'Roma' seyahati buluta kaydedilemeyecek kadar büyük\./);
});
