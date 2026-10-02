import { supabase } from './repository.js';
import { coordinate } from './coords.js';

const DEFAULT_FUNCTION_NAME = 'places';
const DEFAULT_LIMIT = 8;
const MIN_QUERY_LENGTH = 3;

export const NEARBY_CATEGORIES = Object.freeze({
  breakfast: Object.freeze({ primaryType: 'breakfast' }),
  lunch: Object.freeze({ primaryType: 'restaurant' }),
  dinner: Object.freeze({ primaryType: 'restaurant' }),
  cafe: Object.freeze({ primaryType: 'cafe' }),
  attractions: Object.freeze({ primaryType: 'tourist_attraction' })
});

function abortError() {
  return new DOMException('The request was aborted.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

const numberOrNull = coordinate;

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.max(0, Math.round(number));
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.text === 'string') return value.text.trim();
  return '';
}

function googleMapsSearchUrl(place) {
  const explicit = text(place.googleMapsUrl || place.googleMapsUri || place.mapsUri || place.url);
  if (/^https:\/\/(?:www\.)?google\.[^/]+\/maps\//i.test(explicit) || /^https:\/\/maps\.app\.goo\.gl\//i.test(explicit)) {
    return explicit;
  }
  const location = numberOrNull(place.lat) !== null && numberOrNull(place.lng) !== null
    ? `${numberOrNull(place.lat)},${numberOrNull(place.lng)}`
    : [place.name, place.address].filter(Boolean).join(', ');
  const base = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  return place.provider === 'google' && place.id ? `${base}&query_place_id=${encodeURIComponent(place.id)}` : base;
}

function osmIdentity(place) {
  const rawType = text(place.osm_type || place.osmType || place.type).toLowerCase();
  const type = rawType === 'node' || rawType === 'n' ? 'node'
    : rawType === 'way' || rawType === 'w' ? 'way'
      : rawType === 'relation' || rawType === 'r' ? 'relation'
        : 'place';
  const rawIdValue = place.osm_id ?? place.osmId ?? place.place_id ?? place.id;
  const rawId = rawIdValue === null || rawIdValue === undefined ? '' : String(rawIdValue).trim();
  return rawId.startsWith('osm:') ? rawId : `osm:${type}:${rawId || `${place.lat},${place.lng}`}`;
}

export function normalizePlace(place, providerHint = '') {
  if (!place || typeof place !== 'object') return null;
  const source = place.placePrediction || (place.place && typeof place.place === 'object' ? place.place : place);
  if (!source || typeof source !== 'object') return null;
  const inferredProvider = providerHint || source.provider || (source.osm_id || source.osmId || source.display_name ? 'osm' : 'google');
  const provider = inferredProvider === 'osm' || inferredProvider === 'openstreetmap' ? 'osm' : 'google';
  const location = source.location || source.geometry?.location || {};
  const lat = numberOrNull(source.lat ?? source.latitude ?? location.lat ?? location.latitude);
  const lng = numberOrNull(source.lng ?? source.lon ?? source.longitude ?? location.lng ?? location.lon ?? location.longitude);

  const displayName = text(source.displayName || source.name || source.namedetails?.name || source.text || source.structuredFormat?.mainText);
  const address = text(source.formattedAddress || source.formatted_address || source.address?.label || source.display_name || source.structuredFormat?.secondaryText || source.address);
  const name = displayName || address.split(',')[0]?.trim();
  if (!name) return null;

  const id = provider === 'osm'
    ? osmIdentity({ ...source, lat, lng })
    : text(source.id || source.placeId || source.place_id || source.place).replace(/^places\//, '');
  const types = Array.isArray(source.types) ? source.types : [];
  const primaryType = text(source.primaryType || source.primary_type || source.addresstype || source.category || types[0] || source.type) || 'place';
  if (!id && (lat === null || lng === null)) return null;
  const normalized = {
    id: id || `google:${lat},${lng}:${name}`,
    name,
    address,
    lat,
    lng,
    primaryType,
    rating: numberOrNull(source.rating),
    reviewCount: integerOrNull(source.reviewCount ?? source.userRatingCount ?? source.user_ratings_total),
    provider,
    googleMapsUrl: ''
  };
  normalized.googleMapsUrl = googleMapsSearchUrl({ ...source, ...normalized });
  return normalized;
}

function normalizeList(payload, providerHint) {
  const source = Array.isArray(payload) ? payload
    : payload?.places || payload?.suggestions || payload?.predictions || payload?.results || payload?.features || [];
  return source.map((place) => normalizePlace(place, providerHint)).filter(Boolean);
}

function assertCoordinates(lat, lng) {
  const parsedLat = numberOrNull(lat);
  const parsedLng = numberOrNull(lng);
  if (parsedLat === null || parsedLat < -90 || parsedLat > 90 || parsedLng === null || parsedLng < -180 || parsedLng > 180) {
    throw new TypeError('Valid latitude and longitude are required.');
  }
  return { lat: parsedLat, lng: parsedLng };
}

function extractFunctionPayload(data) {
  if (data?.error) throw new Error(text(data.error) || 'The place provider is unavailable.');
  return data?.data ?? data;
}

export class PlaceSearchError extends Error {
  constructor(code, message = '') {
    super(message || code);
    this.name = 'PlaceSearchError';
    this.code = code;
  }
}

const SEARCH_MESSAGES = Object.freeze({
  signed_out: 'Yer aramak için hesabınla giriş yap. Durağı elle de yazabilirsin.',
  unavailable: 'Yer arama şu anda kullanılamıyor. Durağı elle yazabilirsin.',
  quota: 'Bugünkü yer arama sınırına ulaşıldı. Durağı elle yazabilirsin.',
  busy: 'Yer arama şu anda çok yoğun. Biraz sonra yeniden dene veya durağı elle yaz.',
  timeout: 'Yer arama zaman aşımına uğradı. Yeniden dene veya durağı elle yaz.'
});

export function placeSearchMessage(error) {
  const code = typeof error === 'string' ? error : error?.code;
  return SEARCH_MESSAGES[code] || 'Arama şu anda yanıt vermedi; yeri elle yazabilirsin.';
}

// Codes the places function sends in the JSON body of an error response (see supabase/functions/places).
const PROVIDER_CODES = Object.freeze({
  provider_rate_limited: 'busy',
  provider_unavailable: 'unavailable',
  provider_timeout: 'timeout',
  provider_error: 'failed'
});

async function responseCode(response) {
  try {
    const body = await response.clone().json();
    return typeof body?.code === 'string' ? body.code : '';
  } catch {
    return '';
  }
}

async function searchErrorFor(error) {
  if (error instanceof PlaceSearchError) return error;
  const status = Number(error?.context?.status);
  // 429 is only ever the user's own quota; upstream provider trouble arrives as 502/503/504 with a code.
  let code = status === 401 ? 'signed_out' : status === 429 ? 'quota' : status === 503 ? 'unavailable' : status === 504 ? 'timeout' : 'failed';
  if (status >= 500 && error?.context && typeof error.context.clone === 'function') {
    code = PROVIDER_CODES[await responseCode(error.context)] || code;
  }
  return new PlaceSearchError(code, text(error?.message));
}

export function createPlacesClient({ supabaseClient = supabase, functionName = DEFAULT_FUNCTION_NAME } = {}) {
  async function invoke(action, body, signal) {
    throwIfAborted(signal);
    let session = null;
    try { session = (await supabaseClient.auth.getSession())?.data?.session; } catch { /* treated as signed out */ }
    if (!session?.access_token) throw new PlaceSearchError('signed_out');
    throwIfAborted(signal);
    try {
      const { data, error } = await supabaseClient.functions.invoke(functionName, {
        body: { action, ...body },
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal
      });
      if (error) throw error;
      return extractFunctionPayload(data);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw await searchErrorFor(error);
    }
  }

  async function autocomplete(query, { limit = DEFAULT_LIMIT, locationBias, signal } = {}) {
    const cleanQuery = text(query);
    if (cleanQuery.length < MIN_QUERY_LENGTH) return [];
    const safeLimit = Math.max(1, Math.min(20, Math.round(Number(limit) || DEFAULT_LIMIT)));
    const data = await invoke('autocomplete', { query: cleanQuery, limit: safeLimit, locationBias }, signal);
    return normalizeList(data, 'google').slice(0, safeLimit);
  }

  async function details(placeOrId, { signal } = {}) {
    const id = text(typeof placeOrId === 'object' ? placeOrId?.id : placeOrId);
    if (!id) throw new TypeError('A place id is required.');
    if (id.startsWith('osm:')) throw new PlaceSearchError('unavailable');
    const data = await invoke('details', { placeId: id }, signal);
    const result = normalizePlace(data?.place || data?.result || data, 'google');
    if (!result) throw new PlaceSearchError('failed', 'The place provider returned invalid details.');
    return result;
  }

  async function nearby({ lat, lng, category, radiusMeters = 1_500, limit = DEFAULT_LIMIT, signal } = {}) {
    const coordinates = assertCoordinates(lat, lng);
    if (!Object.hasOwn(NEARBY_CATEGORIES, category)) {
      throw new TypeError(`Unknown nearby category: ${String(category || '')}`);
    }
    const safeRadius = Math.max(100, Math.min(10_000, Math.round(Number(radiusMeters) || 1_500)));
    const safeLimit = Math.max(1, Math.min(20, Math.round(Number(limit) || DEFAULT_LIMIT)));
    const data = await invoke('nearby', { ...coordinates, category, radiusMeters: safeRadius, limit: safeLimit }, signal);
    return normalizeList(data, 'google').slice(0, safeLimit);
  }

  return Object.freeze({ autocomplete, details, nearby });
}

const placesClient = createPlacesClient();

export const autocompletePlaces = (...args) => placesClient.autocomplete(...args);
export const getPlaceDetails = (...args) => placesClient.details(...args);
export const findNearbyPlaces = (...args) => placesClient.nearby(...args);

export function debounce(callback, wait = 300) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      callback(...args);
    }, Math.max(0, Number(wait) || 0));
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
