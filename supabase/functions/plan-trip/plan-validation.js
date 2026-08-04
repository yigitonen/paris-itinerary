export const MEAL_ROLES = ["Breakfast", "Lunch", "Dinner"];
export const ALL_MEAL_ROLES = [...MEAL_ROLES, "None"];

export function targetStopsForPace(pace) {
  const normalized = String(pace || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (normalized.includes("yogun") || normalized.includes("fast") || normalized.includes("intense")) return 7;
  if (normalized.includes("dengeli") || normalized.includes("balanced")) return 6;
  return 5;
}

function venueKey(stop) {
  return String(stop?.mapSourceName || stop?.title || "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function timeMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

export function validatePlanShape(value, input) {
  if (!value || typeof value !== "object") throw new Error("Planner response is empty");
  if (!Array.isArray(value.days) || value.days.length !== input.days) {
    throw new Error("Planner returned the wrong number of days");
  }

  const expectedStops = targetStopsForPace(input.pace);
  const venues = new Set();
  value.days.forEach((day, dayIndex) => {
    if (!day || !Array.isArray(day.stops) || day.stops.length !== expectedStops) {
      throw new Error(`Planner must return exactly ${expectedStops} stops for day ${dayIndex + 1}`);
    }
    const mealCounts = Object.fromEntries(MEAL_ROLES.map((role) => [role, 0]));
    const mealPositions = {};
    let previousTime = -1;
    day.stops.forEach((stop, stopIndex) => {
      if (!stop || typeof stop !== "object" || !String(stop.title || "").trim()) {
        throw new Error(`Planner returned an unnamed stop on day ${dayIndex + 1}`);
      }
      const minutes = timeMinutes(stop.time);
      if (minutes === null || minutes <= previousTime) {
        throw new Error(`Planner returned an invalid stop time on day ${dayIndex + 1}`);
      }
      previousTime = minutes;
      const role = String(stop.mealRole || "");
      if (!ALL_MEAL_ROLES.includes(role)) {
        throw new Error(`Planner returned an invalid meal role on day ${dayIndex + 1}`);
      }
      if (MEAL_ROLES.includes(role)) {
        mealCounts[role] += 1;
        mealPositions[role] = stopIndex;
      }
      const key = venueKey(stop);
      if (!key) throw new Error(`Planner returned an invalid venue on day ${dayIndex + 1}`);
      if (venues.has(key)) throw new Error(`Planner repeated venue ${stopIndex + 1} on day ${dayIndex + 1}`);
      venues.add(key);
    });
    for (const role of MEAL_ROLES) {
      if (mealCounts[role] !== 1) throw new Error(`Planner must include exactly one ${role} on day ${dayIndex + 1}`);
    }
    if (!(mealPositions.Breakfast < mealPositions.Lunch && mealPositions.Lunch < mealPositions.Dinner)) {
      throw new Error(`Planner returned meal anchors out of order on day ${dayIndex + 1}`);
    }
  });
  return { expectedStops, totalStops: expectedStops * input.days };
}
