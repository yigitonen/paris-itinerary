import test from "node:test";
import assert from "node:assert/strict";
import { haversineKm, optimizeDayStops, routeDistanceKm } from "./route.js";

const stop = (title, time, lat, lng) => ({ title, time, lat, lng });

test("haversine returns a plausible central-city distance", () => {
  const distance = haversineKm(stop("A", "09:00", 41.8902, 12.4922), stop("B", "10:00", 41.8986, 12.4769));
  assert.ok(distance > 1 && distance < 2);
});

test("optimization never lengthens a day route", () => {
  const input = [
    stop("North", "09:00", 41.93, 12.49),
    stop("South", "10:00", 41.87, 12.49),
    stop("Center", "11:00", 41.90, 12.49)
  ];
  assert.ok(routeDistanceKm(optimizeDayStops(input)) <= routeDistanceKm(input));
});

test("optimization preserves morning, afternoon and evening cadence", () => {
  const input = [
    stop("Morning north", "09:00", 41.93, 12.49),
    stop("Morning center", "10:30", 41.90, 12.49),
    stop("Lunch", "13:00", 41.89, 12.48),
    stop("Museum", "15:00", 41.88, 12.47),
    stop("Dinner", "19:30", 41.91, 12.50)
  ];
  const hours = optimizeDayStops(input).map((item) => Number(item.time.slice(0, 2)));
  assert.deepEqual(hours.map((hour) => hour < 12 ? 0 : hour < 18 ? 1 : 2), [0, 0, 1, 1, 2]);
});

test("walking estimates are attached after the first verified stop", () => {
  const output = optimizeDayStops([
    stop("A", "09:00", 41.90, 12.48),
    stop("B", "10:00", 41.91, 12.49)
  ]);
  assert.equal(output[0].travelFromPreviousMinutes, null);
  assert.ok(output[1].travelFromPreviousMinutes >= 2);
  assert.ok(output[1].travelFromPreviousKm > 0);
});
