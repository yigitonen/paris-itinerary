// The `plan` jsonb document stored in public.trips, and its size limit.
//
// The database caps octet_length(plan::text) at 2,000,000 bytes (migration
// 20261002121000_trips_plan_size_cap.sql). `plan::text` is Postgres' jsonb output, which is
// not JSON.stringify output: jsonb_out writes ": " after every key and ", " between members
// and array items, so the stored text is LARGER than JSON.stringify's compact form (one extra
// byte per member). planSizeBytes() therefore measures with those separators instead of
// calling JSON.stringify. String escaping already matches (both escape ", \ and control
// characters, and keep non-ASCII as UTF-8); key order and duplicate keys do not change length.
//
// TRIP_PLAN_MAX_BYTES leaves ~5% under the 2,000,000 cap for what is still not modelled
// exactly (numeric normalisation such as 1e21 becoming 21 digits, and the exact server-side
// text of unusual values). Realistic trips are around 100 KB.
export const TRIP_PLAN_MAX_BYTES = 1_900_000;

export const buildPlan = (trip) => ({
  source: trip.source || 'manual',
  note: trip.note || '',
  summary: trip.summary || '',
  researchSummary: trip.researchSummary || '',
  researchSources: trip.researchSources || [],
  plannerMeta: trip.plannerMeta || null,
  savedPlaces: trip.savedPlaces || [],
  days: trip.days || [],
  expenses: trip.expenses || [],
  journals: trip.journals || []
});

const encoder = new TextEncoder();
const skipped = (value) => value === undefined || typeof value === 'function' || typeof value === 'symbol';

// Text of a JSON value as Postgres prints jsonb (same value rules as JSON.stringify).
export function jsonbText(value) {
  if (value !== null && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON();
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => skipped(item) ? 'null' : jsonbText(item)).join(', ')}]`;
  const members = [];
  for (const key of Object.keys(value)) {
    if (!skipped(value[key])) members.push(`${JSON.stringify(key)}: ${jsonbText(value[key])}`);
  }
  return `{${members.join(', ')}}`;
}

// UTF-8 size of the plan exactly as repository.toRow() builds it, in the database's own text form.
export const planSizeBytes = (trip) => encoder.encode(jsonbText(buildPlan(trip))).length;

export const isPlanTooLarge = (trip) => planSizeBytes(trip) > TRIP_PLAN_MAX_BYTES;

export class TripTooLargeError extends Error {
  constructor(trip) {
    super(`'${trip?.title || trip?.destination || 'Seyahat'}' seyahati buluta kaydedilemeyecek kadar büyük. Bu cihazda saklanıyor; kaydetmek için gün, not veya günlük sayısını azalt.`);
    this.name = 'TripTooLargeError';
    this.code = 'plan_too_large';
  }
}

export function assertPlanFits(trip) {
  if (isPlanTooLarge(trip)) throw new TripTooLargeError(trip);
}
