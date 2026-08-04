import assert from 'node:assert/strict';
import test from 'node:test';
import { getTripWeather, weatherLabel } from './weather.js';

test('labels known and unknown weather codes', () => {
  assert.equal(weatherLabel(0), 'Açık');
  assert.equal(weatherLabel(999), 'Değişken');
});

test('maps an Open-Meteo daily forecast', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ daily: { time: ['2026-08-12'], weather_code: [1], temperature_2m_max: [27.2], temperature_2m_min: [18.4], precipitation_probability_max: [12] } }) });
  assert.deepEqual(await getTripWeather({ lat: 41, lng: 12, startDate: '2026-08-12', endDate: '2026-08-12', fetchImpl }), [{ date: '2026-08-12', label: 'Çoğunlukla açık', max: 27, min: 18, rain: 12 }]);
});
