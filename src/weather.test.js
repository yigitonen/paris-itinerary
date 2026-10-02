import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTemperature, getTripWeather, hasWeatherData, weatherLabel } from './weather.js';

test('labels known and unknown weather codes', () => {
  assert.equal(weatherLabel(0), 'Açık');
  assert.equal(weatherLabel(999), 'Değişken');
});

test('skips the request when coordinates are missing', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  for (const [lat, lng] of [[null, null], ['', ''], [undefined, 12], [41, null]]) {
    assert.deepEqual(await getTripWeather({ lat, lng, startDate: '2026-08-12', endDate: '2026-08-12', fetchImpl }), []);
  }
  assert.equal(called, false);
});

test('still fetches for a real 0 latitude', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ daily: {} }) }; };
  await getTripWeather({ lat: 0, lng: 0, startDate: '2026-08-12', endDate: '2026-08-12', fetchImpl });
  assert.equal(called, true);
});

test('maps an Open-Meteo daily forecast', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ daily: { time: ['2026-08-12'], weather_code: [1], temperature_2m_max: [27.2], temperature_2m_min: [18.4], precipitation_probability_max: [12] } }) });
  assert.deepEqual(await getTripWeather({ lat: 41, lng: 12, startDate: '2026-08-12', endDate: '2026-08-12', fetchImpl }), [{ date: '2026-08-12', label: 'Çoğunlukla açık', max: 27, min: 18, rain: 12 }]);
});

const forecastOf = (daily) => getTripWeather({
  lat: 41, lng: 12, startDate: '2026-08-12', endDate: '2026-08-13',
  fetchImpl: async () => ({ ok: true, json: async () => ({ daily }) })
});

test('keeps missing Open-Meteo values as null instead of 0', async () => {
  const [day] = await forecastOf({ time: ['2026-08-12'], weather_code: [null], temperature_2m_max: [null], temperature_2m_min: [null], precipitation_probability_max: [null] });
  assert.deepEqual(day, { date: '2026-08-12', label: null, max: null, min: null, rain: null });
});

test('treats arrays that are absent or shorter than the dates as missing', async () => {
  const days = await forecastOf({ time: ['2026-08-12', '2026-08-13'], temperature_2m_max: [24.6] });
  assert.deepEqual(days.map((day) => [day.max, day.min, day.rain, day.label]), [[25, null, null, null], [null, null, null, null]]);
});

test('a real 0 degrees and 0% rain stay 0', async () => {
  const [day] = await forecastOf({ time: ['2026-08-12'], weather_code: [0], temperature_2m_max: [0.2], temperature_2m_min: [-0.4], precipitation_probability_max: [0] });
  assert.deepEqual(day, { date: '2026-08-12', label: 'Açık', max: 0, min: 0, rain: 0 });
  assert.equal(formatTemperature(day.max), '0°');
});

test('ignores non-numeric values', async () => {
  const [day] = await forecastOf({ time: ['2026-08-12'], temperature_2m_max: ['abc'], temperature_2m_min: [NaN], precipitation_probability_max: [''] });
  assert.deepEqual([day.max, day.min, day.rain], [null, null, null]);
});

test('formats a missing temperature as a dash', () => {
  assert.equal(formatTemperature(null), '—');
  assert.equal(formatTemperature(undefined), '—');
  assert.equal(formatTemperature(-3), '-3°');
});

test('a day without any value is not worth showing, a partial one is', () => {
  assert.equal(hasWeatherData({ date: '2026-08-12', label: null, max: null, min: null, rain: null }), false);
  assert.equal(hasWeatherData({ date: '2026-08-12', label: null, max: null, min: 0, rain: null }), true);
  assert.equal(hasWeatherData({ date: '2026-08-12', label: null, max: null, min: null, rain: 0 }), true);
  assert.equal(hasWeatherData(undefined), false);
});
