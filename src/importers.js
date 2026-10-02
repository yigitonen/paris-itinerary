import { coordinate } from './coords.js';

const text = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';

export function parseGoogleSavedPlaces(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.features) ? value.features : Array.isArray(value?.locations) ? value.locations : [];
  const seen = new Set();
  return source.map((item) => {
    const properties = item?.properties || item || {};
    const location = properties.Location || properties.location || {};
    const coordinates = item?.geometry?.coordinates || properties.coordinates || [];
    const name = text(properties.Title, properties.title, properties.name, location['Business Name'], location.name);
    const lat = coordinate(properties.latitude) ?? coordinate(location.Latitude) ?? coordinate(coordinates[1]);
    const lng = coordinate(properties.longitude) ?? coordinate(location.Longitude) ?? coordinate(coordinates[0]);
    const address = text(properties.Address, properties.address, location.Address, location.address);
    const googleMapsUrl = text(properties['Google Maps URL'], properties.googleMapsUrl, properties.url, location['Google Maps URL']);
    if (!name || lat === null || lng === null) return null;
    const key = `${name.toLocaleLowerCase('tr-TR')}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { id: crypto.randomUUID(), name, address, lat, lng, provider: googleMapsUrl ? 'google' : 'saved', googleMapsUrl, primaryType: 'saved_place' };
  }).filter(Boolean).slice(0, 500);
}
