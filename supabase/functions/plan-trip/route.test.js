import test from "node:test";
import assert from "node:assert/strict";
import { haversineKm, isMealAnchor, optimizeDayStops, routeDistanceKm } from "./route.js";

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

test("meal anchors keep their positions and order during optimization", () => {
  const input = [
    { ...stop("Breakfast", "08:00", 41.90, 12.48), mealRole: "Breakfast" },
    stop("Far sight", "10:00", 41.94, 12.48),
    stop("Near sight", "11:00", 41.91, 12.48),
    { ...stop("Lunch", "13:00", 41.89, 12.47), mealRole: "Lunch" },
    stop("Evening sight", "17:00", 41.88, 12.46),
    { ...stop("Dinner", "20:00", 41.87, 12.45), mealRole: "Dinner" }
  ];
  const output = optimizeDayStops(input);
  assert.deepEqual(output.filter(isMealAnchor).map((item) => item.title), ["Breakfast", "Lunch", "Dinner"]);
  assert.deepEqual(output.map((item, index) => isMealAnchor(item) ? index : null).filter((value) => value !== null), [0, 3, 5]);
  assert.equal(output[0].time, "08:00");
  assert.equal(output[3].time, "13:00");
  assert.equal(output[5].time, "20:00");
});

test("a missing coordinate leaves the stop order unchanged", () => {
  const input = [
    stop("A", "09:00", 41.90, 12.48),
    stop("Unknown", "10:00", null, null),
    stop("B", "11:00", 41.91, 12.49)
  ];
  assert.deepEqual(optimizeDayStops(input).map((item) => item.title), ["A", "Unknown", "B"]);
});
