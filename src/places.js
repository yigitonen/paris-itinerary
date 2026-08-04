import { supabase } from './repository.js';

const DEFAULT_FUNCTION_NAME = 'places';
const DEFAULT_NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const DEFAULT_LIMIT = 8;
const MIN_QUERY_LENGTH = 3;

export const NEARBY_CATEGORIES = Object.freeze({
  breakfast: Object.freeze({ primaryType: 'breakfast', osmQuery: 'breakfast' }),
  lunch: Object.freeze({ primaryType: 'restaurant', osmQuery: 'restaurant' }),
  dinner: Object.freeze({ primaryType: 'restaurant', osmQuery: 'restaurant' }),
  cafe: Object.freeze({ primaryType: 'cafe', osmQuery: 'cafe' }),
  attractions: Object.freeze({ primaryType: 'tourist_attraction', osmQuery: 'tourist attraction' })
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

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

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

async function responseError(response) {
  let detail = '';
  try {
    const body = await response.clone().json();
    detail = text(body?.error || body?.message);
  } catch {
    try { detail = text(await response.clone().text()); } catch { /* keep status only */ }
  }
  return new Error(detail || `Place search failed with HTTP ${response.status}.`);
}

async function fetchJson(fetchImpl, url, signal) {
  throwIfAborted(signal);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Accept-Language': 'tr,en;q=0.8' },
    signal
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

function boundsAround(lat, lng, radiusMeters) {
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeDelta = radiusMeters / Math.max(1, 111_320 * Math.cos(lat * Math.PI / 180));
  return {
    west: lng - longitudeDelta,
    north: lat + latitudeDelta,
    east: lng + longitudeDelta,
    south: lat - latitudeDelta
  };
}

function addLocationBias(params, bias) {
  const lat = numberOrNull(bias?.lat);
  const lng = numberOrNull(bias?.lng);
  if (lat === null || lng === null) return;
  const bounds = boundsAround(lat, lng, Math.max(500, Number(bias.radiusMeters) || 25_000));
  params.set('viewbox', `${bounds.west},${bounds.north},${bounds.east},${bounds.south}`);
}

function osmLookupId(id) {
  const match = /^osm:(node|way|relation|n|w|r):(\d+)$/i.exec(String(id || ''));
  if (!match) return '';
  const type = { node: 'N', n: 'N', way: 'W', w: 'W', relation: 'R', r: 'R' }[match[1].toLowerCase()];
  return `${type}${match[2]}`;
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

export function createPlacesClient({
  supabaseClient = supabase,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  functionName = DEFAULT_FUNCTION_NAME,
  nominatimUrl = DEFAULT_NOMINATIM_URL
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const nominatimBase = String(nominatimUrl).replace(/\/$/, '');

  async function invoke(action, body, signal) {
    throwIfAborted(signal);
    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError || !sessionData?.session?.access_token) throw new Error('Authenticated place search is unavailable.');
    throwIfAborted(signal);
    const { data, error } = await supabaseClient.functions.invoke(functionName, {
      body: { action, ...body },
      headers: { Authorization: `Bearer ${sessionData.session.access_token}` },
      signal
    });
    if (error) throw error;
    return extractFunctionPayload(data);
  }

  async function osmAutocomplete(query, { limit, locationBias, signal }) {
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: query,
      addressdetails: '1',
      namedetails: '1',
      limit: String(limit)
    });
    addLocationBias(params, locationBias);
    return normalizeList(await fetchJson(fetchImpl, `${nominatimBase}/search?${params}`, signal), 'osm');
  }

  async function autocomplete(query, { limit = DEFAULT_LIMIT, locationBias, signal } = {}) {
    const cleanQuery = text(query);
    if (cleanQuery.length < MIN_QUERY_LENGTH) return [];
    const safeLimit = Math.max(1, Math.min(20, Math.round(Number(limit) || DEFAULT_LIMIT)));
    try {
      const data = await invoke('autocomplete', { query: cleanQuery, limit: safeLimit, locationBias }, signal);
      return normalizeList(data, 'google').slice(0, safeLimit);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return osmAutocomplete(cleanQuery, { limit: safeLimit, locationBias, signal });
    }
  }

  async function osmDetails(placeOrId, { query, signal }) {
    const place = typeof placeOrId === 'object' ? placeOrId : null;
    const lookupId = osmLookupId(place?.id || placeOrId);
    if (lookupId) {
      const params = new URLSearchParams({ format: 'jsonv2', osm_ids: lookupId, addressdetails: '1', namedetails: '1' });
      const results = normalizeList(await fetchJson(fetchImpl, `${nominatimBase}/lookup?${params}`, signal), 'osm');
      if (results[0]) return results[0];
    }
    const fallbackQuery = text(query || place?.name || place?.address);
    if (fallbackQuery.length < MIN_QUERY_LENGTH) throw new Error('Place details are unavailable without a searchable name.');
    const results = await osmAutocomplete(fallbackQuery, { limit: 1, locationBias: place, signal });
    if (!results[0]) throw new Error('Place details were not found.');
    return results[0];
  }

  async function details(placeOrId, { query, signal } = {}) {
    const id = text(typeof placeOrId === 'object' ? placeOrId?.id : placeOrId);
    if (!id) throw new TypeError('A place id is required.');
    if (id.startsWith('osm:')) return osmDetails(placeOrId, { query, signal });
    try {
      const data = await invoke('details', { placeId: id }, signal);
      const result = normalizePlace(data?.place || data?.result || data, 'google');
      if (!result) throw new Error('The place provider returned invalid details.');
      return result;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return osmDetails(placeOrId, { query, signal });
    }
  }

  async function osmNearby({ lat, lng, category, radiusMeters, limit, signal }) {
    const bounds = boundsAround(lat, lng, radiusMeters);
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: NEARBY_CATEGORIES[category].osmQuery,
      addressdetails: '1',
      namedetails: '1',
      bounded: '1',
      viewbox: `${bounds.west},${bounds.north},${bounds.east},${bounds.south}`,
      limit: String(limit)
    });
    return normalizeList(await fetchJson(fetchImpl, `${nominatimBase}/search?${params}`, signal), 'osm');
  }

  async function nearby({ lat, lng, category, radiusMeters = 1_500, limit = DEFAULT_LIMIT, signal } = {}) {
    const coordinates = assertCoordinates(lat, lng);
    if (!Object.hasOwn(NEARBY_CATEGORIES, category)) {
      throw new TypeError(`Unknown nearby category: ${String(category || '')}`);
    }
    const safeRadius = Math.max(100, Math.min(10_000, Math.round(Number(radiusMeters) || 1_500)));
    const safeLimit = Math.max(1, Math.min(20, Math.round(Number(limit) || DEFAULT_LIMIT)));
    const request = { ...coordinates, category, radiusMeters: safeRadius, limit: safeLimit };
    try {
      const data = await invoke('nearby', request, signal);
      return normalizeList(data, 'google').slice(0, safeLimit);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return osmNearby({ ...request, signal });
    }
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
