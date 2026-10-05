import { COVER_IMAGES } from './data.js';
import { isPlanTooLarge } from './trip-plan.js';

export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
export const BACKUP_MAX_TRIPS = 200;

export class BackupError extends Error {
  constructor(code, message = code, extra = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const TRIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHILD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const DAY_MS = 86400000;
const STATUSES = ['planning', 'upcoming', 'active', 'past'];
const IMPORTANCE = ['must-see', 'local', 'optional'];
const MEAL_ROLES = ['Breakfast', 'Lunch', 'Dinner', 'None'];
const BOOKING = ['none', 'needed', 'booked'];
const defaultMakeId = () => crypto.randomUUID();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key) && object[key] !== undefined;
const invalid = (field) => { throw new BackupError('invalid_trip', `Invalid backup trip: ${field}`); };

function clean(value, max, multiline = false) {
  if (typeof value !== 'string') return null;
  let text = multiline
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    : value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  text = text.trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text;
}
const str = (value, max, fallback = '', multiline = false) => clean(value, max, multiline) || fallback;
const required = (value, max, field) => clean(value, max) || invalid(field);
const oneOf = (value, list, fallback) => list.includes(value) ? value : fallback;
const pick = (value, key, list) => isObject(value) && has(value, key) ? oneOf(value[key], list, undefined) : undefined;

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC.test(value.trim())) return Number(value.trim());
  return null;
}
const ranged = (value, min, max) => { const number = toNumber(value); return number !== null && number >= min && number <= max ? number : null; };
const integer = (value, min, max) => { const number = ranged(value, min, max); return number !== null && Number.isInteger(number) ? number : null; };

const isoDate = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
};
const addDays = (date, offset) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
const isoDateTime = (value, fallback) => typeof value === 'string' && DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : fallback;

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : '';
  } catch { return ''; }
}

function coordinates(lat, lng) {
  const a = ranged(lat, -90, 90);
  const b = ranged(lng, -180, 180);
  return a !== null && b !== null ? { lat: a, lng: b } : { lat: null, lng: null };
}
const withCoordinates = (out, source) => {
  if (has(source, 'lat') || has(source, 'lng')) Object.assign(out, coordinates(source.lat, source.lng));
};
const provider = (value) => value === 'osm' ? 'saved' : oneOf(value, ['google', 'saved', ''], '');

function childId(value, seen, makeId) {
  let id = typeof value === 'string' && CHILD_ID.test(value) && !seen.has(value) ? value : makeId();
  while (seen.has(id)) id = makeId();
  seen.add(id);
  return id;
}

function normalizeStop(raw, { seen, makeId }) {
  if (!isObject(raw)) invalid('stop');
  const stop = {
    id: childId(raw.id, seen, makeId),
    title: required(raw.title, 120, 'stop.title'),
    time: typeof raw.time === 'string' && TIME.test(raw.time) ? raw.time : ''
  };
  for (const [key, max, multiline] of [['category', 40], ['duration', 40], ['notes', 1000, true], ['why', 400, true], ['travelerNote', 400, true], ['address', 240], ['query', 180], ['confirmation', 200], ['mapsSourceName', 200], ['placeId', 300]]) {
    if (has(raw, key)) stop[key] = str(raw[key], max, '', multiline);
  }
  const importance = pick(raw, 'importance', IMPORTANCE);
  if (importance) stop.importance = importance;
  const mealRole = pick(raw, 'mealRole', MEAL_ROLES);
  if (mealRole) stop.mealRole = mealRole;
  stop.bookingStatus = oneOf(raw.bookingStatus, BOOKING, 'none');
  stop.provider = provider(raw.provider);
  stop.googleMapsUrl = safeUrl(raw.googleMapsUrl);
  stop.mapsSourceUrl = safeUrl(raw.mapsSourceUrl);
  if (has(raw, 'rating')) stop.rating = ranged(raw.rating, 0, 5);
  if (has(raw, 'reviewCount')) stop.reviewCount = integer(raw.reviewCount, 0, Number.MAX_SAFE_INTEGER);
  stop.verified = raw.verified === true;
  if (has(raw, 'reminderAt')) {
    const reminder = clean(raw.reminderAt, 40);
    stop.reminderAt = reminder && !Number.isNaN(Date.parse(reminder)) ? reminder : '';
  }
  for (const key of ['travelFromPreviousMinutes', 'travelFromPreviousKm']) {
    const value = has(raw, key) ? ranged(raw[key], 0, 100000) : null;
    if (value !== null) stop[key] = value;
  }
  withCoordinates(stop, raw);
  return stop;
}

function normalizeDay(raw, index, startDate, context) {
  if (!isObject(raw)) invalid('day');
  if (has(raw, 'stops') && !Array.isArray(raw.stops)) invalid('day.stops');
  return {
    id: childId(raw.id, context.seen, context.makeId),
    date: isoDate(raw.date) || addDays(startDate, index),
    title: str(raw.title, 100, `${index + 1}. gün`),
    theme: str(raw.theme, 180),
    stops: (raw.stops || []).slice(0, 30).map((stop) => normalizeStop(stop, context))
  };
}

function normalizeExpense(raw, currency, { seen, makeId }, now) {
  if (!isObject(raw)) invalid('expense');
  const amount = ranged(raw.amount, 0, 1e9);
  if (amount === null) invalid('expense.amount');
  const own = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  return {
    id: childId(raw.id, seen, makeId),
    title: required(raw.title, 120, 'expense.title'),
    category: str(raw.category, 40, 'Diğer'),
    amount,
    currency: /^[A-Z]{3}$/.test(own) ? own : currency,
    createdAt: isoDateTime(raw.createdAt, now)
  };
}

function normalizeJournal(raw, { seen, makeId }, now) {
  if (!isObject(raw)) invalid('journal');
  return {
    id: childId(raw.id, seen, makeId),
    title: required(raw.title, 160, 'journal.title'),
    body: str(raw.body, 20000, '', true),
    createdAt: isoDateTime(raw.createdAt, now)
  };
}

function normalizeSources(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((item) => {
    if (!isObject(item)) return null;
    const url = safeUrl(item.url);
    if (!url) return null;
    const source = { title: str(item.title, 200), url };
    if (has(item, 'provider')) source.provider = str(item.provider, 40);
    return source;
  }).filter(Boolean);
}

function normalizeMeta(value) {
  if (!isObject(value)) return null;
  const meta = {};
  for (const key of ['provider', 'routeMethod']) if (has(value, key)) meta[key] = str(value[key], 120);
  for (const key of ['researched', 'routeOptimized', 'routeSequenced', 'timeSensitiveDetailsNeedRecheck']) if (has(value, key)) meta[key] = value[key] === true;
  for (const key of ['verifiedPlaces', 'totalPlaces', 'stopsPerDay', 'mealsPerDay', 'coordinatePlaces', 'coordinateOptimizedDays']) if (has(value, key)) meta[key] = integer(value[key], 0, 1000) ?? 0;
  return meta;
}

function normalizePlaces(list, context) {
  return (Array.isArray(list) ? list : []).slice(0, 500).map((item) => {
    if (!isObject(item)) return null;
    const name = clean(item.name, 160);
    if (!name) return null;
    const place = { id: childId(item.id, context.seen, context.makeId), name };
    if (has(item, 'address')) place.address = str(item.address, 240);
    withCoordinates(place, item);
    if (has(item, 'provider')) place.provider = provider(item.provider);
    if (has(item, 'googleMapsUrl')) place.googleMapsUrl = safeUrl(item.googleMapsUrl);
    if (has(item, 'primaryType')) place.primaryType = str(item.primaryType, 40);
    return place;
  }).filter(Boolean);
}

export function normalizeBackupTrip(raw, { makeId = defaultMakeId } = {}) {
  if (!isObject(raw)) invalid('trip');
  const destination = required(raw.destination, 100, 'destination');
  const startDate = isoDate(raw.startDate) || invalid('startDate');
  const endDate = isoDate(raw.endDate) || invalid('endDate');
  const span = Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / DAY_MS);
  if (span < 0 || span > 365) invalid('dates');
  if (!Array.isArray(raw.days) || raw.days.length < 1 || raw.days.length > 60) invalid('days');
  for (const list of ['expenses', 'journals']) if (has(raw, list) && !Array.isArray(raw[list])) invalid(list);

  const now = new Date().toISOString();
  const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency.trim().toUpperCase()) ? raw.currency.trim().toUpperCase() : 'EUR';
  const context = { seen: new Set(), makeId };
  const trip = {
    id: typeof raw.id === 'string' && TRIP_ID.test(raw.id) ? raw.id.toLowerCase() : makeId(),
    title: str(raw.title, 100, destination),
    destination,
    country: str(raw.country, 100),
    startDate,
    endDate,
    durationDays: span + 1,
    status: oneOf(raw.status, STATUSES, 'planning'),
    style: str(raw.style, 40, 'Dengeli'),
    pace: str(raw.pace, 40, 'Rahat'),
    coverKey: typeof raw.coverKey === 'string' && Object.hasOwn(COVER_IMAGES, raw.coverKey) ? raw.coverKey : 'default',
    budgetTotal: ranged(raw.budgetTotal, 0, 1e9) ?? 0,
    currency,
    source: raw.source === 'gemini' ? 'gemini' : 'manual'
  };
  for (const [key, max] of [['note', 600], ['summary', 600], ['researchSummary', 1000]]) if (has(raw, key)) trip[key] = str(raw[key], max, '', true);
  if (has(raw, 'researchSources')) trip.researchSources = normalizeSources(raw.researchSources);
  if (has(raw, 'plannerMeta')) trip.plannerMeta = normalizeMeta(raw.plannerMeta);
  trip.days = raw.days.map((day, index) => normalizeDay(day, index, startDate, context));
  if (has(raw, 'savedPlaces')) trip.savedPlaces = normalizePlaces(raw.savedPlaces, context);
  trip.expenses = (raw.expenses || []).slice(0, 1000).map((expense) => normalizeExpense(expense, currency, context, now));
  trip.journals = (raw.journals || []).slice(0, 1000).map((journal) => normalizeJournal(journal, context, now));
  trip.createdAt = isoDateTime(raw.createdAt, now);
  trip.updatedAt = isoDateTime(raw.updatedAt, now);
  return trip;
}

export function parseBackup(text, { makeId = defaultMakeId } = {}) {
  if (typeof text !== 'string') throw new BackupError('invalid_json');
  if (new TextEncoder().encode(text).length > BACKUP_MAX_BYTES) throw new BackupError('too_large');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new BackupError('invalid_json'); }
  let list;
  if (isObject(parsed) && Object.hasOwn(parsed, 'trips')) list = parsed.trips;
  else if (isObject(parsed) && Object.hasOwn(parsed, 'destination')) list = [parsed];
  if (!Array.isArray(list) || !list.length) throw new BackupError('invalid_format');
  if (list.length > BACKUP_MAX_TRIPS) throw new BackupError('too_many');
  const ids = new Set();
  const trips = list.map((item, index) => {
    let trip;
    try { trip = normalizeBackupTrip(item, { makeId }); } catch (error) {
      if (error instanceof BackupError) error.index = index;
      throw error;
    }
    // Checked after normalizing, on the plan a cloud save would send. Like an invalid trip, one oversized trip rejects the whole file.
    if (isPlanTooLarge(trip)) throw new BackupError('trip_too_large', 'Backup trip plan is too large', { index, title: trip.title });
    while (ids.has(trip.id)) trip.id = makeId();
    ids.add(trip.id);
    return trip;
  });
  return { trips };
}

export const serializeBackup = (trips, { exportedAt = new Date() } = {}) => JSON.stringify({ version: 1, exportedAt: exportedAt.toISOString(), trips }, null, 2);
export const serializeTrip = (trip) => JSON.stringify(trip, null, 2);

export function backupErrorMessage(error) {
  if (error?.code === 'too_large') return 'Yedek dosyası çok büyük (en fazla 5 MB).';
  if (error?.code === 'too_many') return 'Bir yedekte en fazla 200 seyahat olabilir.';
  if (error?.code === 'trip_too_large') return `'${error.title || 'Bir'}' seyahati buluta kaydedilemeyecek kadar büyük. Seyahati küçültüp (daha az gün, not veya günlük) yeniden dene; dosyadan hiçbir seyahat içe aktarılmadı.`;
  return 'Bu dosya geçerli bir Roamly yedeği değil.';
}
