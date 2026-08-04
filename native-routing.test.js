import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeDestination } from "./native-routing.js";

test("parses a custom-scheme route", () => {
  assert.deepEqual(parseNativeDestination("roamly://memories"), { route: "memories", tripId: "" });
});

test("parses a custom-scheme trip", () => {
  assert.deepEqual(parseNativeDestination("roamly://trip/trip-42"), { route: "trips", tripId: "trip-42" });
});

test("accepts a production HTTPS route and rejects unknown routes", () => {
  assert.deepEqual(
    parseNativeDestination("https://roamly-travel.yigitonen.chatgpt.site/?route=settings"),
    { route: "settings", tripId: "" }
  );
  assert.deepEqual(parseNativeDestination("roamly://unknown"), { route: "home", tripId: "" });
});
