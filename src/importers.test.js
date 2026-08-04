import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGoogleSavedPlaces } from './importers.js';

test('parses Google Takeout GeoJSON saved places and removes duplicates', () => {
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [12.48, 41.89] }, properties: { Title: 'Roma', Address: 'Roma, Italy', 'Google Maps URL': 'https://maps.google.com/example' } };
  const places = parseGoogleSavedPlaces({ type: 'FeatureCollection', features: [feature, feature] });
  assert.equal(places.length, 1);
  assert.deepEqual({ name: places[0].name, lat: places[0].lat, lng: places[0].lng, provider: places[0].provider }, { name: 'Roma', lat: 41.89, lng: 12.48, provider: 'google' });
});

test('rejects entries without a name or coordinates', () => {
  assert.deepEqual(parseGoogleSavedPlaces([{ name: 'No location' }, { latitude: 1, longitude: 2 }]), []);
});
