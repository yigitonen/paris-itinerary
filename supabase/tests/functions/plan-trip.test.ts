// plan-trip: authentication, quota reservation and settlement, against the real
// handler with a fake Supabase and fake Gemini (no network).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { SERVICE_KEY, USER_ID, FakeBackend, VALID_TOKEN, authed, loadHandler, postJson, run } from "./harness.ts";

const handler = await loadHandler(new URL("../../functions/plan-trip/index.ts", import.meta.url));

const input = { destination: "Paris", startDate: "2026-12-01", days: 1, style: "Dengeli", pace: "Dengeli", note: "" };
const go = (configure: (b: FakeBackend) => void = () => {}, env: Record<string, string | null> = {}, body: unknown = input, headers = authed) =>
  run(handler, postJson(body, headers), configure, env);

// A believable two-step Gemini exchange: a grounded Maps brief, then the final JSON.
const mapsReply = {
  body: {
    candidates: [{
      content: { parts: [{ text: "Day 1 in Paris: breakfast at Cafe Uno, Louvre, lunch at Bistro Due, Seine walk, Musee Tre, dinner at Resto Quattro. ".repeat(2) }] },
      groundingMetadata: { groundingChunks: [{ maps: { uri: "https://maps.google.com/?cid=1", title: "Cafe Uno" } }] }
    }]
  }
};
const stop = (time: string, title: string, mealRole: string, lat: number, lng: number) => ({
  time, title, query: `${title} Paris`, mapSourceName: title === "Cafe Uno" ? "Cafe Uno" : "", category: "Durak", duration: "1 saat",
  notes: "", why: "", travelerNote: "", importance: "must-see", mealRole, address: "", lat, lng
});
const plan = {
  title: "Paris", country: "Fransa", summary: "Bir gün",
  days: [{
    title: "1. gün", theme: "Klasikler",
    stops: [
      stop("09:00", "Cafe Uno", "Breakfast", 48.85, 2.34),
      stop("10:30", "Louvre", "None", 48.86, 2.33),
      stop("12:30", "Bistro Due", "Lunch", 48.86, 2.34),
      stop("14:30", "Seine Walk", "None", 48.855, 2.345),
      stop("16:30", "Musee Tre", "None", 48.86, 2.31),
      stop("19:00", "Resto Quattro", "Dinner", 48.85, 2.35)
    ]
  }]
};
const finalReply = { body: { candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] } };
const happy = (b: FakeBackend) => {
  b.providerQueue.push(mapsReply, finalReply);
};

function assertNoPaidWork(backend: FakeBackend) {
  assertEquals(backend.providerCalls.length, 0, "the paid provider must not be called");
}

// --- authentication --------------------------------------------------------------------------

Deno.test("OPTIONS answers CORS preflight without touching any backend", async () => {
  const r = await run(handler, new Request("https://x.test/fn", { method: "OPTIONS", headers: { Origin: "https://localhost" } }));
  assertEquals(r.status, 200);
  assertEquals(r.response.headers.get("Access-Control-Allow-Origin"), "https://localhost");
  assertEquals(r.backend.calls.length, 0);
});

Deno.test("non-POST methods are rejected with 405", async () => {
  const r = await run(handler, new Request("https://x.test/fn", { method: "GET", headers: authed }));
  assertEquals(r.status, 405);
  assertEquals(r.backend.calls.length, 0);
});

Deno.test("request without Authorization header gets 401 and does no work", async () => {
  const r = await go(happy, {}, input, {} as any);
  assertEquals(r.status, 401);
  assertEquals(r.body.error, "Authentication required");
  assertEquals(r.backend.calls.length, 0, "no auth, quota or provider call may happen");
});

Deno.test("Authorization header that is not a Bearer token gets 401", async () => {
  for (const header of ["Basic abc", "bearer lowercase", VALID_TOKEN, ""]) {
    const r = await go(happy, {}, input, { Authorization: header });
    assertEquals(r.status, 401, `header ${JSON.stringify(header)}`);
    assertEquals(r.backend.reserveCalls.length, 0);
    assertNoPaidWork(r.backend);
  }
});

Deno.test("an invalid or expired token gets 401 before any quota is reserved", async () => {
  const r = await go(happy, {}, input, { Authorization: "Bearer forged.jwt.value" });
  assertEquals(r.status, 401);
  assertEquals(r.backend.authCalls.length, 1);
  assertEquals(r.backend.authCalls[0].headers["authorization"], "Bearer forged.jwt.value");
  assertEquals(r.backend.reserveCalls.length, 0);
  assertNoPaidWork(r.backend);
});

Deno.test("the anon key is not accepted as a user token", async () => {
  const r = await go(happy, {}, input, { Authorization: "Bearer anon-key-for-tests" });
  assertEquals(r.status, 401);
  assertEquals(r.backend.reserveCalls.length, 0);
});

// --- validation and configuration happen before quota is touched ------------------------------

Deno.test("invalid input is a 400 and never reserves quota", async () => {
  for (const bad of [{}, { ...input, days: 0 }, { ...input, days: 8 }, { ...input, destination: "x" }, { ...input, startDate: "2026-02-30" }]) {
    const r = await go(happy, {}, bad);
    assertEquals(r.status, 400, JSON.stringify(bad));
    assertEquals(r.backend.reserveCalls.length, 0);
    assertNoPaidWork(r.backend);
  }
});

Deno.test("a body that is not JSON is a client error and never reserves quota", async () => {
  const r = await go(happy, {}, "{not json");
  assertEquals(r.status, 400);
  assertEquals(r.backend.reserveCalls.length, 0);
  assertNoPaidWork(r.backend);
});

Deno.test("missing Gemini key returns configuration_missing without reserving quota", async () => {
  const r = await go(happy, { GEMINI_API_KEY: null });
  assertEquals(r.status, 503);
  assertEquals(r.body.code, "configuration_missing");
  assertEquals(r.backend.reserveCalls.length, 0);
});

Deno.test("missing service role key fails closed with quota_unavailable and never calls Gemini", async () => {
  const r = await go(happy, { SUPABASE_SERVICE_ROLE_KEY: null });
  assertEquals(r.status, 503);
  assertEquals(r.body.code, "quota_unavailable");
  assertNoPaidWork(r.backend);
});

// --- reservation ------------------------------------------------------------------------------

Deno.test("the reservation uses the service role key and the authenticated user's id, with the shared policy", async () => {
  const r = await go(happy);
  assertEquals(r.status, 200);
  assertEquals(r.backend.reserveCalls.length, 1);
  const call = r.backend.reserveCalls[0];
  assertEquals(call.headers["authorization"], `Bearer ${SERVICE_KEY}`);
  assertEquals(call.headers["apikey"], SERVICE_KEY);
  assertEquals(call.body, {
    p_user_id: USER_ID, p_provider: "gemini_plan", p_action: "plan",
    p_success_limit: 3, p_attempt_limit: 10, p_cooldown_seconds: 60, p_max_in_flight: 1,
    p_global_daily_limit: 200, p_stale_seconds: 180
  });
});

Deno.test("the user id comes from the verified token, never from the request body", async () => {
  const r = await go(happy, {}, { ...input, userId: "99999999-9999-4999-8999-999999999999", user_id: "99999999-9999-4999-8999-999999999999" });
  assertEquals(r.status, 200);
  assertEquals(r.backend.reserveCalls[0].body.p_user_id, USER_ID);
});

Deno.test("AI_GLOBAL_DAILY_LIMIT overrides the global budget passed to the database", async () => {
  const r = await go(happy, { AI_GLOBAL_DAILY_LIMIT: "7" });
  assertEquals(r.backend.reserveCalls[0].body.p_global_daily_limit, 7);
});

for (const reason of ["global_budget", "daily_limit", "cooldown", "in_progress", "attempt_limit"]) {
  Deno.test(`a ${reason} denial returns 429 with code "${reason}" and never calls Gemini`, async () => {
    // Provider replies are queued, so a leak into Gemini would be visible as a recorded provider call.
    const denied = await go((b) => {
      happy(b);
      b.reserve = () => ({ body: { allowed: false, reason, retry_after_seconds: 321 } });
    });
    assertEquals(denied.status, 429);
    assertEquals(denied.body.code, reason);
    assertEquals(denied.body.retryAfterSeconds, 321);
    assertEquals(denied.response.headers.get("Retry-After"), "321");
    assert(typeof denied.body.error === "string" && denied.body.error.length > 0);
    assertNoPaidWork(denied.backend);
    assertEquals(denied.backend.finishCalls.length, 0, "a denied request has nothing to settle");
  });
}

Deno.test("global_budget denial message is the one the client shows", async () => {
  const r = await go((b) => {
    b.reserve = () => ({ body: { allowed: false, reason: "global_budget", retry_after_seconds: 3600 } });
  });
  assertStringIncludes(r.body.error, "kapasitesi doldu");
});

Deno.test("a failing reservation RPC fails closed: 503 quota_unavailable, Gemini never called", async () => {
  for (const reply of [
    { status: 500, body: { code: "XX000", message: "boom" } },
    { status: 404, body: { code: "PGRST202", message: "Could not find the function public.reserve_provider_usage" } },
    { status: 200, body: null },
    new Error("connection reset")
  ]) {
    const r = await go((b) => {
      happy(b);
      b.reserve = () => reply as any;
    });
    assertEquals(r.status, 503, JSON.stringify(reply));
    assertEquals(r.body.code, "quota_unavailable");
    assertNoPaidWork(r.backend);
    assertEquals(r.backend.finishCalls.length, 0);
  }
});

// --- success and settlement --------------------------------------------------------------------

Deno.test("success: two Gemini calls, the plan is returned and the reservation is settled once as succeeded", async () => {
  const r = await go((b) => {
    happy(b);
    b.reserve = () => ({ body: { allowed: true, reservation_id: "res-42" } });
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.trip.days.length, 1);
  assertEquals(r.body.trip.days[0].stops.length, 6);
  assertEquals(r.backend.providerCalls.length, 2);
  for (const call of r.backend.providerCalls) assertEquals(call.headers["x-goog-api-key"], "gemini-key");
  assertEquals(r.backend.finishCalls.length, 1);
  assertEquals(r.backend.finishCalls[0].body, { p_reservation_id: "res-42", p_succeeded: true, p_failure_reason: null });
  assertEquals(r.backend.finishCalls[0].headers["authorization"], `Bearer ${SERVICE_KEY}`);
  // The reservation happens strictly before the first paid call, the settlement strictly after the last.
  const order = r.backend.calls.map((c) => c.path.split("/").pop());
  assertEquals(order.indexOf("reserve_provider_usage") < order.findIndex((p) => p?.includes("generateContent")), true);
  assertEquals(order.at(-1), "finish_provider_usage");
});

const failures: Array<{ name: string; replies: any[]; status: number; reason: string; maybeMessage?: string }> = [
  { name: "Gemini quota exhausted (429)", replies: [{ status: 429, body: { error: { message: "quota" } } }], status: 429, reason: "provider_quota" },
  { name: "Gemini key rejected (403)", replies: [{ status: 403, body: {} }], status: 403, reason: "provider_auth" },
  { name: "Gemini rejects the request (400)", replies: [{ status: 400, body: {} }], status: 400, reason: "provider_rejected" },
  { name: "Gemini outage (503)", replies: [{ status: 503, body: {} }], status: 503, reason: "provider_error" },
  { name: "network failure", replies: [new TypeError("fetch failed")], status: 500, reason: "provider_error" },
  { name: "request timeout", replies: [new DOMException("aborted", "AbortError")], status: 504, reason: "timeout" },
  { name: "ungrounded brief (no Maps sources)", replies: [{ body: { candidates: [{ content: { parts: [{ text: "x".repeat(200) }] } }] } }], status: 500, reason: "grounding" },
  { name: "final answer is not JSON", replies: [mapsReply, { body: { candidates: [{ content: { parts: [{ text: "sorry, no plan" }] } }] } }], status: 500, reason: "invalid_output" },
  {
    name: "final answer has the wrong number of days",
    replies: [mapsReply, { body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ ...plan, days: [] }) }] } }] } }],
    status: 500, reason: "invalid_output"
  },
  { name: "second Gemini call fails", replies: [mapsReply, { status: 500, body: {} }], status: 500, reason: "provider_error" }
];

for (const failure of failures) {
  Deno.test(`provider failure (${failure.name}) settles the reservation once as failed (${failure.reason})`, async () => {
    const r = await go((b) => {
      b.providerQueue.push(...failure.replies);
      b.reserve = () => ({ body: { allowed: true, reservation_id: "res-7" } });
    });
    assertEquals(r.status, failure.status);
    assert(typeof r.body.error === "string");
    assertEquals(r.backend.finishCalls.length, 1, "settled exactly once");
    assertEquals(r.backend.finishCalls[0].body, { p_reservation_id: "res-7", p_succeeded: false, p_failure_reason: failure.reason });
    assert(!("trip" in r.body), "no itinerary on failure");
  });
}

Deno.test("a failure while settling does not turn a successful plan into an error", async () => {
  const r = await go((b) => {
    happy(b);
    b.finish = () => ({ status: 500, body: { message: "db down" } });
  });
  assertEquals(r.status, 200);
  assertEquals(r.backend.finishCalls.length, 1);
  assert(r.logs.some((line) => line.includes("could not be settled")), "settlement failure is logged");
});

Deno.test("the Gemini error detail is not leaked to the client", async () => {
  const r = await go((b) => {
    b.providerQueue.push({ status: 500, body: { error: { message: "SECRET-INTERNAL-DETAIL key=abc" } } });
  });
  assert(!JSON.stringify(r.body).includes("SECRET-INTERNAL-DETAIL"));
});
