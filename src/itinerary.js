const MEAL_WORDS = {
  breakfast: ['breakfast', 'kahvaltı', 'kahvalti', 'brunch'],
  lunch: ['lunch', 'öğle', 'ogle'],
  dinner: ['dinner', 'akşam', 'aksam']
};

const PACE_TARGETS = { Rahat: 5, Dengeli: 6, 'Yoğun': 7 };

export function mealRole(stop = {}) {
  const explicit = String(stop.mealRole || '').toLowerCase();
  if (['breakfast', 'lunch', 'dinner'].includes(explicit)) return explicit;
  const text = `${stop.category || ''} ${stop.title || ''}`.toLocaleLowerCase('tr-TR');
  return Object.entries(MEAL_WORDS).find(([, words]) => words.some((word) => text.includes(word)))?.[0] || '';
}

export function dayReadiness(day, pace = 'Rahat') {
  const stops = day?.stops || [];
  const meals = new Set(stops.map(mealRole).filter(Boolean));
  const target = PACE_TARGETS[pace] || 5;
  return {
    stopCount: stops.length,
    target,
    meals: [...meals],
    hasBreakfast: meals.has('breakfast'),
    hasLunch: meals.has('lunch'),
    hasDinner: meals.has('dinner'),
    complete: stops.length >= target && ['breakfast', 'lunch', 'dinner'].every((role) => meals.has(role))
  };
}

export function shiftTime(value, minutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return value;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function shiftDay(day, minutes, fromStopId = '') {
  let shift = !fromStopId;
  return {
    ...day,
    stops: (day?.stops || []).map((stop) => {
      if (stop.id === fromStopId) shift = true;
      return shift ? { ...stop, time: shiftTime(stop.time, minutes) } : stop;
    })
  };
}

export function moveStop(day, stopId, direction) {
  const stops = [...(day?.stops || [])];
  const index = stops.findIndex((stop) => stop.id === stopId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= stops.length) return day;
  [stops[index], stops[next]] = [stops[next], stops[index]];
  const times = (day.stops || []).map((stop) => stop.time);
  return { ...day, stops: stops.map((stop, position) => ({ ...stop, time: times[position] || stop.time })) };
}

const located = (stop) => Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng));
const distance = (a, b) => {
  const lat = (Number(a.lat) - Number(b.lat)) * 111;
  const lng = (Number(a.lng) - Number(b.lng)) * 111 * Math.cos(Number(a.lat) * Math.PI / 180);
  return Math.hypot(lat, lng);
};

function nearestNeighbor(stops, start) {
  const remaining = [...stops];
  const result = [];
  let cursor = start;
  while (remaining.length) {
    const index = cursor && located(cursor)
      ? remaining.reduce((best, stop, current) => distance(cursor, stop) < distance(cursor, remaining[best]) ? current : best, 0)
      : 0;
    cursor = remaining.splice(index, 1)[0];
    result.push(cursor);
  }
  return result;
}

export function optimizeDay(day) {
  const original = day?.stops || [];
  if (original.filter(located).length < 2) return day;
  const anchors = original.map((stop, index) => mealRole(stop) ? index : -1).filter((index) => index >= 0);
  const ordered = [];
  let cursor = 0;
  let previous = null;
  for (const anchorIndex of [...anchors, original.length]) {
    const block = original.slice(cursor, anchorIndex).filter(located);
    const unlocated = original.slice(cursor, anchorIndex).filter((stop) => !located(stop));
    const sorted = nearestNeighbor(block, previous);
    ordered.push(...sorted, ...unlocated);
    if (anchorIndex < original.length) {
      ordered.push(original[anchorIndex]);
      previous = original[anchorIndex];
    } else previous = ordered.at(-1) || previous;
    cursor = anchorIndex + 1;
  }
  const times = original.map((stop) => stop.time);
  return { ...day, stops: ordered.map((stop, index) => ({ ...stop, time: times[index] || stop.time })) };
}

export function dayCenter(day) {
  const stops = (day?.stops || []).filter(located);
  if (!stops.length) return null;
  return {
    lat: stops.reduce((sum, stop) => sum + Number(stop.lat), 0) / stops.length,
    lng: stops.reduce((sum, stop) => sum + Number(stop.lng), 0) / stops.length
  };
}

export function googleDayRouteUrl(day) {
  const stops = (day?.stops || []).filter((stop) => located(stop) || stop.address || stop.title);
  if (!stops.length) return '';
  const query = (stop) => located(stop) ? `${stop.lat},${stop.lng}` : stop.address || stop.title;
  const origin = query(stops[0]);
  const destination = query(stops.at(-1));
  const waypoints = stops.slice(1, -1).map(query).join('|');
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'walking' });
  if (waypoints) params.set('waypoints', waypoints);
  return `https://www.google.com/maps/dir/?${params}`;
}

export function tiktokSearchUrl(query, destination = '') {
  return `https://www.tiktok.com/search?q=${encodeURIComponent([query, destination].filter(Boolean).join(' '))}`;
}
