const EARTH_RADIUS_KM = 6371;

function radians(value) {
  return value * Math.PI / 180;
}

function hasCoordinates(stop) {
  return Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
}

export function haversineKm(a, b) {
  if (!hasCoordinates(a) || !hasCoordinates(b)) return 0;
  const latDelta = radians(b.lat - a.lat);
  const lngDelta = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

export function routeDistanceKm(stops) {
  return stops.slice(1).reduce((total, stop, index) => total + haversineKm(stops[index], stop), 0);
}

function timeBand(time = "") {
  const hour = Number(String(time).split(":")[0]);
  if (!Number.isFinite(hour) || hour < 12) return 0;
  if (hour < 18) return 1;
  return 2;
}

function permutations(items) {
  if (items.length < 2) return [items];
  return items.flatMap((item, index) => permutations(items.filter((_, itemIndex) => itemIndex !== index))
    .map((rest) => [item, ...rest]));
}

function groupCost(group, previous) {
  return (previous ? haversineKm(previous, group[0]) : 0) + routeDistanceKm(group);
}

function bestGroupOrder(group, previous) {
  if (group.length > 7 || group.some((stop) => !hasCoordinates(stop))) return group;
  return permutations(group).reduce((best, candidate) => (
    groupCost(candidate, previous) < groupCost(best, previous) ? candidate : best
  ), group);
}

function attachWalkingLegs(stops) {
  return stops.map((stop, index) => {
    if (!index || !hasCoordinates(stop) || !hasCoordinates(stops[index - 1])) {
      return { ...stop, travelFromPreviousKm: null, travelFromPreviousMinutes: null };
    }
    const straightLineKm = haversineKm(stops[index - 1], stop);
    const walkingKm = straightLineKm * 1.22;
    return {
      ...stop,
      travelFromPreviousKm: Number(walkingKm.toFixed(1)),
      travelFromPreviousMinutes: Math.max(2, Math.round(walkingKm / 4.7 * 60))
    };
  });
}

export function optimizeDayStops(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return attachWalkingLegs(stops || []);
  const original = [...stops];
  const grouped = [0, 1, 2].map((band) => original.filter((stop) => timeBand(stop.time) === band));
  let previous = null;
  const candidate = grouped.flatMap((group) => {
    const optimized = bestGroupOrder(group, previous);
    previous = optimized.at(-1) || previous;
    return optimized;
  });
  const ordered = routeDistanceKm(candidate) <= routeDistanceKm(original) ? candidate : original;
  return attachWalkingLegs(ordered);
}
