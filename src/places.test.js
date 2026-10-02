import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlacesClient, debounce, NEARBY_CATEGORIES, normalizePlace, placeSearchMessage } from './places.js';

function mockSupabase({ session = { access_token: 'session-token' }, invoke } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      auth: {
        getSession: async () => ({ data: { session }, error: null })
      },
      functions: {
        invoke: async (name, options) => {
          calls.push({ name, options });
          return invoke ? invoke(name, options) : { data: { places: [] }, error: null };
        }
      }
    }
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('does not search before the three-character minimum', async () => {
  const edge = mockSupabase();
  const client = createPlacesClient({ supabaseClient: edge.client });

  assert.deepEqual(await client.autocomplete('  ab  '), []);
  assert.equal(edge.calls.length, 0);
});

test('uses an authenticated Edge Function and normalizes Google autocomplete results', async () => {
  const edge = mockSupabase({
    invoke: async () => ({
      data: {
        places: [{
          placeId: 'google-123',
          displayName: { text: 'Louvre Museum' },
          formattedAddress: 'Paris, France',
          location: { latitude: 48.8606, longitude: 2.3376 },
          primaryType: 'museum',
          rating: 4.7,
          userRatingCount: 330000
        }]
      },
      error: null
    })
  });
  const controller = new AbortController();
  const client = createPlacesClient({ supabaseClient: edge.client });

  const results = await client.autocomplete('Louvre', { signal: controller.signal, limit: 5 });

  assert.deepEqual(results, [{
    id: 'google-123',
    name: 'Louvre Museum',
    address: 'Paris, France',
    lat: 48.8606,
    lng: 2.3376,
    primaryType: 'museum',
    rating: 4.7,
    reviewCount: 330000,
    provider: 'google',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=48.8606%2C2.3376&query_place_id=google-123'
  }]);
  assert.equal(edge.calls[0].name, 'places');
  assert.equal(edge.calls[0].options.headers.Authorization, 'Bearer session-token');
  assert.equal(edge.calls[0].options.signal, controller.signal);
  assert.deepEqual(edge.calls[0].options.body, {
    action: 'autocomplete',
    query: 'Louvre',
    limit: 5,
    locationBias: undefined
  });
});

function failingFetch(t) {
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('no direct network request is allowed');
  t.after(() => { globalThis.fetch = original; });
}

test('signed-out search asks for sign-in without any network request', async (t) => {
  failingFetch(t);
  const edge = mockSupabase({ session: null });
  const client = createPlacesClient({ supabaseClient: edge.client });

  await assert.rejects(client.autocomplete('Galata'), { code: 'signed_out' });
  await assert.rejects(client.details('google-1'), { code: 'signed_out' });
  await assert.rejects(client.nearby({ lat: 48.85, lng: 2.35, category: 'cafe' }), { code: 'signed_out' });
  assert.equal(edge.calls.length, 0);
});

test('a 503 from the places function reports search as unavailable', async (t) => {
  failingFetch(t);
  const body = '{"error":"Google Places is not configured.","code":"places_not_configured"}';
  const edge = mockSupabase({ invoke: async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: new Response(body, { status: 503 }) }) }) });
  const client = createPlacesClient({ supabaseClient: edge.client });

  await assert.rejects(client.autocomplete('Topkapı'), { code: 'unavailable' });
  assert.equal(edge.calls.length, 1);
});

test('a 401 from the places function reports signed out', async () => {
  const edge = mockSupabase({ invoke: async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: new Response('{}', { status: 401 }) }) }) });
  await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).autocomplete('Topkapı'), { code: 'signed_out' });
});

test('a 429 reports the daily limit', async () => {
  const edge = mockSupabase({ invoke: async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: new Response('{"error":"Daily place search limit reached."}', { status: 429 }) }) }) });
  await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).autocomplete('Topkapı'), { code: 'quota' });
});

test('provider failures from the places function map to distinct codes', async (t) => {
  failingFetch(t);
  const cases = [
    [503, 'provider_rate_limited', 'busy'],
    [503, 'provider_unavailable', 'unavailable'],
    [503, 'quota_unavailable', 'unavailable'],
    [504, 'provider_timeout', 'timeout'],
    [504, '', 'timeout'],
    [502, 'provider_error', 'failed'],
    [502, '', 'failed']
  ];
  for (const [status, code, expected] of cases) {
    const body = code ? JSON.stringify({ error: 'x', code }) : 'not json';
    const edge = mockSupabase({ invoke: async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: new Response(body, { status }) }) }) });
    await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).autocomplete('Topkapı'), { code: expected }, `${status} ${code}`);
  }
});

test('a 429 stays the daily limit even if the body carries a provider code', async () => {
  const body = JSON.stringify({ code: 'provider_rate_limited' });
  const edge = mockSupabase({ invoke: async () => ({ data: null, error: Object.assign(new Error('non-2xx'), { context: new Response(body, { status: 429 }) }) }) });
  await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).autocomplete('Topkapı'), { code: 'quota' });
});

test('other function failures report a failed search', async (t) => {
  failingFetch(t);
  for (const error of [new Error('provider key missing'), Object.assign(new Error('non-2xx'), { context: new Response('{}', { status: 500 }) })]) {
    const edge = mockSupabase({ invoke: async () => ({ data: null, error }) });
    await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).autocomplete('Topkapı'), { code: 'failed' });
  }
  const edge = mockSupabase({ invoke: async () => ({ data: { error: 'boom' }, error: null }) });
  await assert.rejects(createPlacesClient({ supabaseClient: edge.client }).nearby({ lat: 1, lng: 2, category: 'cafe' }), { code: 'failed' });
});

test('propagates aborts without a second request', async () => {
  const controller = new AbortController();
  let invokeCalls = 0;
  const edge = mockSupabase({
    invoke: async (_name, options) => {
      invokeCalls += 1;
      controller.abort();
      throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    }
  });
  const client = createPlacesClient({ supabaseClient: edge.client });

  await assert.rejects(client.autocomplete('Museum', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(invokeCalls, 1);
});

test('legacy OpenStreetMap ids are not looked up', async (t) => {
  failingFetch(t);
  const edge = mockSupabase();
  const client = createPlacesClient({ supabaseClient: edge.client });

  await assert.rejects(client.details('osm:node:1'), { code: 'unavailable' });
  await assert.rejects(client.details({ id: 'osm:relation:99', name: 'Grand Bazaar' }), { code: 'unavailable' });
  assert.equal(edge.calls.length, 0);
});

test('normalizes Edge Function details and keeps an explicit Google Maps URL', async () => {
  const edge = mockSupabase({
    invoke: async () => ({
      data: { place: { id: 'abc', name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744, mapsUri: 'https://www.google.com/maps/place/Sagrada+Familia' } },
      error: null
    })
  });
  const client = createPlacesClient({ supabaseClient: edge.client });

  const place = await client.details('abc');
  assert.equal(place.googleMapsUrl, 'https://www.google.com/maps/place/Sagrada+Familia');
  assert.equal(edge.calls[0].options.body.action, 'details');
  assert.equal(edge.calls[0].options.body.placeId, 'abc');
});

test('nearby uses the places function for every category', async (t) => {
  failingFetch(t);
  assert.deepEqual(Object.keys(NEARBY_CATEGORIES), ['breakfast', 'lunch', 'dinner', 'cafe', 'attractions']);
  for (const category of Object.keys(NEARBY_CATEGORIES)) {
    const edge = mockSupabase({ invoke: async () => ({ data: { places: [{ placeId: 'g1', displayName: { text: 'Nearby Place' }, location: { latitude: 48.86, longitude: 2.34 } }] }, error: null }) });
    const results = await createPlacesClient({ supabaseClient: edge.client }).nearby({ lat: 48.8566, lng: 2.3522, category, radiusMeters: 1200 });
    assert.equal(results[0].provider, 'google');
    assert.equal(edge.calls.length, 1);
    assert.equal(edge.calls[0].options.body.action, 'nearby');
    assert.equal(edge.calls[0].options.body.category, category);
  }
});

test('validates nearby coordinates and categories before network access', async () => {
  const edge = mockSupabase();
  const client = createPlacesClient({ supabaseClient: edge.client });

  await assert.rejects(client.nearby({ lat: 120, lng: 2, category: 'cafe' }), /latitude and longitude/);
  await assert.rejects(client.nearby({ lat: 48, lng: 2, category: 'nightlife' }), /Unknown nearby category/);
  assert.equal(edge.calls.length, 0);
});

test('normalizer rejects incomplete provider rows', () => {
  assert.deepEqual(normalizePlace({ placePrediction: {
    place: 'places/google-prediction',
    text: { text: 'Musée de Orsay' },
    structuredFormat: { secondaryText: { text: 'Paris, France' } },
    types: ['museum']
  } }, 'google'), {
    id: 'google-prediction',
    name: 'Musée de Orsay',
    address: 'Paris, France',
    lat: null,
    lng: null,
    primaryType: 'museum',
    rating: null,
    reviewCount: null,
    provider: 'google',
    googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=Mus%C3%A9e%20de%20Orsay%2C%20Paris%2C%20France&query_place_id=google-prediction'
  });
  assert.equal(normalizePlace({ name: 'Missing identity and location' }, 'google'), null);
  assert.equal(normalizePlace(null), null);
});

test('debounce runs only the latest call and can be cancelled', async () => {
  const values = [];
  const delayed = debounce((value) => values.push(value), 10);
  delayed('first');
  delayed('latest');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(values, ['latest']);

  delayed('cancelled');
  delayed.cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(values, ['latest']);
});

test('placeSearchMessage returns Turkish copy for each code', () => {
  assert.equal(placeSearchMessage('signed_out'), 'Yer aramak için hesabınla giriş yap. Durağı elle de yazabilirsin.');
  assert.equal(placeSearchMessage({ code: 'unavailable' }), 'Yer arama şu anda kullanılamıyor. Durağı elle yazabilirsin.');
  assert.equal(placeSearchMessage({ code: 'quota' }), 'Bugünkü yer arama sınırına ulaşıldı. Durağı elle yazabilirsin.');
  assert.equal(placeSearchMessage({ code: 'busy' }), 'Yer arama şu anda çok yoğun. Biraz sonra yeniden dene veya durağı elle yaz.');
  assert.equal(placeSearchMessage({ code: 'timeout' }), 'Yer arama zaman aşımına uğradı. Yeniden dene veya durağı elle yaz.');
  assert.equal(placeSearchMessage({ code: 'failed' }), 'Arama şu anda yanıt vermedi; yeri elle yazabilirsin.');
  assert.equal(placeSearchMessage(new Error('x')), 'Arama şu anda yanıt vermedi; yeri elle yazabilirsin.');
  assert.equal(placeSearchMessage(undefined), 'Arama şu anda yanıt vermedi; yeri elle yazabilirsin.');
});

test('places client no longer references the public geocoder', () => {
  const source = readFileSync(new URL('./places.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, new RegExp(['nomina', 'tim|openstreetmap\\.org'].join(''), 'i'));
});
