import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlacesClient, debounce, normalizePlace } from './places.js';

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
  let fetchCalls = 0;
  const client = createPlacesClient({
    supabaseClient: edge.client,
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse([]); }
  });

  assert.deepEqual(await client.autocomplete('  ab  '), []);
  assert.equal(edge.calls.length, 0);
  assert.equal(fetchCalls, 0);
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
  const client = createPlacesClient({ supabaseClient: edge.client, fetchImpl: async () => assert.fail('fallback should not run') });

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

test('falls back to Nominatim without a signed-in session', async () => {
  const edge = mockSupabase({ session: null });
  const urls = [];
  const client = createPlacesClient({
    supabaseClient: edge.client,
    fetchImpl: async (url, options) => {
      urls.push({ url: String(url), options });
      return jsonResponse([{
        osm_type: 'node',
        osm_id: 42,
        name: 'Galata Tower',
        display_name: 'Galata Tower, Beyoğlu, İstanbul',
        lat: '41.0256',
        lon: '28.9741',
        addresstype: 'attraction'
      }]);
    }
  });

  const [place] = await client.autocomplete('Galata');

  assert.equal(place.id, 'osm:node:42');
  assert.equal(place.provider, 'osm');
  assert.equal(place.name, 'Galata Tower');
  assert.equal(place.primaryType, 'attraction');
  assert.match(place.googleMapsUrl, /^https:\/\/www\.google\.com\/maps\/search/);
  assert.match(urls[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
  assert.equal(new URL(urls[0].url).searchParams.get('q'), 'Galata');
  assert.equal(urls[0].options.headers['Accept-Language'], 'tr,en;q=0.8');
});

test('falls back when the Edge Function or provider is unavailable', async () => {
  const edge = mockSupabase({ invoke: async () => ({ data: null, error: new Error('provider key missing') }) });
  let fallbackCalls = 0;
  const client = createPlacesClient({
    supabaseClient: edge.client,
    fetchImpl: async () => {
      fallbackCalls += 1;
      return jsonResponse([{ osm_type: 'way', osm_id: 7, display_name: 'Topkapı Palace, İstanbul', lat: 41.0115, lon: 28.9834, type: 'museum' }]);
    }
  });

  const results = await client.autocomplete('Topkapı');
  assert.equal(results[0].provider, 'osm');
  assert.equal(fallbackCalls, 1);
});

test('propagates aborts without starting a fallback request', async () => {
  const controller = new AbortController();
  let fallbackCalls = 0;
  const edge = mockSupabase({
    invoke: async (_name, options) => {
      controller.abort();
      throw options.signal.reason || new DOMException('Aborted', 'AbortError');
    }
  });
  const client = createPlacesClient({
    supabaseClient: edge.client,
    fetchImpl: async () => { fallbackCalls += 1; return jsonResponse([]); }
  });

  await assert.rejects(client.autocomplete('Museum', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fallbackCalls, 0);
});

test('loads OSM details through the Nominatim lookup endpoint', async () => {
  const edge = mockSupabase({ session: null });
  let requestedUrl = '';
  const client = createPlacesClient({
    supabaseClient: edge.client,
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse([{ osm_type: 'relation', osm_id: 99, display_name: 'Grand Bazaar, İstanbul', lat: '41.0107', lon: '28.9681', type: 'retail' }]);
    }
  });

  const place = await client.details('osm:relation:99');
  assert.equal(place.id, 'osm:relation:99');
  assert.equal(new URL(requestedUrl).pathname, '/lookup');
  assert.equal(new URL(requestedUrl).searchParams.get('osm_ids'), 'R99');
});

test('normalizes Edge Function details and keeps an explicit Google Maps URL', async () => {
  const edge = mockSupabase({
    invoke: async () => ({
      data: { place: { id: 'abc', name: 'Sagrada Família', address: 'Barcelona', lat: 41.4036, lng: 2.1744, mapsUri: 'https://www.google.com/maps/place/Sagrada+Familia' } },
      error: null
    })
  });
  const client = createPlacesClient({ supabaseClient: edge.client, fetchImpl: async () => assert.fail('fallback should not run') });

  const place = await client.details('abc');
  assert.equal(place.googleMapsUrl, 'https://www.google.com/maps/place/Sagrada+Familia');
  assert.equal(edge.calls[0].options.body.action, 'details');
  assert.equal(edge.calls[0].options.body.placeId, 'abc');
});

test('supports all nearby categories and sends bounded fallback searches', async () => {
  const categories = ['breakfast', 'lunch', 'dinner', 'cafe', 'attractions'];
  for (const category of categories) {
    const edge = mockSupabase({ session: null });
    let requestedUrl = '';
    const client = createPlacesClient({
      supabaseClient: edge.client,
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return jsonResponse([{ osm_type: 'node', osm_id: 1, display_name: 'Nearby Place, Paris', lat: 48.86, lon: 2.34, type: 'amenity' }]);
      }
    });

    const results = await client.nearby({ lat: 48.8566, lng: 2.3522, category, radiusMeters: 1200 });
    const params = new URL(requestedUrl).searchParams;
    assert.equal(results[0].provider, 'osm');
    assert.equal(params.get('bounded'), '1');
    assert.ok(params.get('viewbox'));
    assert.ok(params.get('q'));
  }
});

test('validates nearby coordinates and categories before network access', async () => {
  const edge = mockSupabase();
  const client = createPlacesClient({ supabaseClient: edge.client, fetchImpl: async () => assert.fail('network should not run') });

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
