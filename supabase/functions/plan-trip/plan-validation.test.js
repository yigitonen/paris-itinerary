import test from "node:test";
import assert from "node:assert/strict";
import { targetStopsForPace, validatePlanShape } from "./plan-validation.js";

const roles = ["Breakfast", "None", "Lunch", "None", "Dinner", "None", "None"];

function fixture(days, pace) {
  const count = targetStopsForPace(pace);
  return {
    title: "Fixture trip",
    days: Array.from({ length: days }, (_, dayIndex) => ({
      title: `Day ${dayIndex + 1}`,
      stops: Array.from({ length: count }, (_, stopIndex) => ({
        time: `${String(8 + stopIndex * 2).padStart(2, "0")}:00`,
        title: `Place ${dayIndex + 1}-${stopIndex + 1}`,
        mapSourceName: `Place ${dayIndex + 1}-${stopIndex + 1}`,
        mealRole: roles[stopIndex]
      }))
    }))
  };
}

for (const [days, pace, count] of [[2, "Rahat", 5], [4, "Dengeli", 6], [7, "Yoğun", 7]]) {
  test(`accepts a full ${days}-day ${pace} fixture`, () => {
    const result = validatePlanShape(fixture(days, pace), { days, pace });
    assert.deepEqual(result, { expectedStops: count, totalStops: days * count });
  });
}

test("rejects an underfilled day", () => {
  const plan = fixture(2, "Rahat");
  plan.days[1].stops.pop();
  assert.throws(() => validatePlanShape(plan, { days: 2, pace: "Rahat" }), /exactly 5 stops/);
});

test("rejects a missing meal anchor", () => {
  const plan = fixture(4, "Dengeli");
  plan.days[0].stops[4].mealRole = "None";
  assert.throws(() => validatePlanShape(plan, { days: 4, pace: "Dengeli" }), /exactly one Dinner/);
});

test("rejects meal anchors in the wrong order", () => {
  const plan = fixture(2, "Rahat");
  plan.days[0].stops[0].mealRole = "Lunch";
  plan.days[0].stops[2].mealRole = "Breakfast";
  assert.throws(() => validatePlanShape(plan, { days: 2, pace: "Rahat" }), /meal anchors out of order/);
});

test("rejects a repeated venue across days", () => {
  const plan = fixture(7, "Yoğun");
  plan.days[6].stops[6].mapSourceName = plan.days[0].stops[0].mapSourceName;
  assert.throws(() => validatePlanShape(plan, { days: 7, pace: "Yoğun" }), /repeated venue/);
});
