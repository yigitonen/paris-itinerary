import { hasLocation } from './coords.js';

const descriptions = {
  0: 'Açık', 1: 'Çoğunlukla açık', 2: 'Parçalı bulutlu', 3: 'Kapalı',
  45: 'Sisli', 48: 'Kırağılı sis', 51: 'Hafif çiseleme', 53: 'Çiseleme', 55: 'Yoğun çiseleme',
  61: 'Hafif yağmur', 63: 'Yağmur', 65: 'Kuvvetli yağmur', 71: 'Hafif kar', 73: 'Kar', 75: 'Yoğun kar',
  80: 'Kısa yağmur', 81: 'Sağanak', 82: 'Kuvvetli sağanak', 95: 'Gök gürültülü', 96: 'Dolu ihtimali', 99: 'Kuvvetli fırtına'
};

export const weatherLabel = (code) => descriptions[Number(code)] || 'Değişken';

export async function getTripWeather({ lat, lng, startDate, endDate, fetchImpl = fetch, signal } = {}) {
  if (!hasLocation({ lat, lng })) return [];
  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng), timezone: 'auto', start_date: startDate, end_date: endDate,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
  });
  const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`, { signal });
  if (!response.ok) throw new Error('Weather forecast is unavailable.');
  const daily = (await response.json()).daily || {};
  return (daily.time || []).map((date, index) => ({
    date, label: weatherLabel(daily.weather_code?.[index]), max: Math.round(daily.temperature_2m_max?.[index]),
    min: Math.round(daily.temperature_2m_min?.[index]), rain: Math.round(daily.precipitation_probability_max?.[index] || 0)
  }));
}
