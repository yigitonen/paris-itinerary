// places: authentication, quota reservation and settlement, against the real
// handler with a fake Supabase and fake Google Places (no network).

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@1";
import { SERVICE_KEY, USER_ID, FakeBackend, authed, loadHandler, postJson, run } from "./harness.ts";

const handler = await loadHandler(new URL("../../functions/places/index.ts", import.meta.url));

const go = (body: unknown, configure: (b: FakeBackend) => void = () => {}, env: Record<string, string | null> = {}, headers: Record<string, string> = authed) =>
  run(handler, postJson(body, headers), configure, env);

const autocomplete = { action: "autocomplete", query: "louvre", sessionToken: "tok-1" };
const details = { action: "details", placeId: "ChIJ-louvre" };
const nearby = { action: "nearby", lat: 48.86, lng: 2.33, category: "cafe" };

const googleOk = (call: { path: string }) => {
  if (call.path.endsWith(":autocomplete")) {
    return { body: { suggestions: [{ placePrediction: { placeId: "p1", text: { text: "Louvre Museum" } } }] } };
  }
  if (call.path.endsWith(":searchNearby")) {
    return { body: { places: [{ id: "p2", displayName: { text: "Cafe Uno" }, formattedAddress: "1 Rue", location: { latitude: 48.8, longitude: 2.3 } }] } };
  }
  return { body: { id: "p1", displayName: { text: "Louvre" }, formattedAddress: "Rue de Rivoli", location: { latitude: 48.86, longitude: 2.33 }, rating: 4.7, userRatingCount: 100, googleMapsUri: "https://maps.google.com/?cid=1" } };
};
const happy = (b: FakeBackend) => {
  b.provider = googleOk;
};

// --- authentication --------------------------------------------------------------------------

Deno.test("OPTIONS preflight needs no auth and touches no backend", async () => {
  const r = await run(handler, new Request("https://x.test/fn", { method: "OPTIONS", headers: { Origin: "https://localhost" } }));
  assertEquals(r.status, 204);
  assertEquals(r.response.headers.get("Access-Control-Allow-Origin"), "https://localhost");
  assertEquals(r.backend.calls.length, 0);
});

Deno.test("non-POST methods are rejected with 405", async () => {
  const r = await run(handler, new Request("https://x.test/fn", { method: "GET", headers: authed }));
  assertEquals(r.status, 405);
});

Deno.test("request without Authorization header gets 401 and does no work", async () => {
  const r = await go(autocomplete, happy, {}, {});
  assertEquals(r.status, 401);
  assertEquals(r.backend.reserveCalls.length, 0);
  assertEquals(r.backend.providerCalls.length, 0);
});

Deno.test("invalid bearer tokens get 401 before any quota is reserved", async () => {
  for (const header of ["Bearer forged.jwt", "Bearer ", "Basic abc", "garbage"]) {
    const r = await go(autocomplete, happy, {}, { Authorization: header });
    assertEquals(r.status, 401, header);
    assertEquals(r.backend.reserveCalls.length, 0, header);
    assertEquals(r.backend.providerCalls.length, 0, header);
  }
});

Deno.test("a valid token is checked against Supabase auth with that exact token", async () => {
  const r = await go(autocomplete, happy);
  assertEquals(r.status, 200);
  assertEquals(r.backend.authCalls.length, 1);
  assertEquals(r.backend.authCalls[0].headers["authorization"], authed.Authorization);
});

// --- validation happens before quota ---------------------------------------------------------

Deno.test("malformed requests are rejected without consuming quota or calling Google", async () => {
  const cases: Array<[string, unknown, number]> = [
    ["unknown action", { action: "delete" }, 400],
    ["no action", {}, 400],
    ["non-JSON body", "{not json", 400],
    ["details without id", { action: "details" }, 400],
    ["nearby without location", { action: "nearby", category: "cafe" }, 400],
    ["nearby out-of-range location", { action: "nearby", lat: 95, lng: 2, category: "cafe" }, 400],
    ["nearby unknown category", { action: "nearby", lat: 1, lng: 2, category: "casino" }, 400],
    ["autocomplete too short", { action: "autocomplete", query: "lo" }, 200]
  ];
  for (const [label, body, status] of cases) {
    const r = await go(body, happy);
    assertEquals(r.status, status, label);
    assertEquals(r.backend.reserveCalls.length, 0, `${label}: must not reserve quota`);
    assertEquals(r.backend.providerCalls.length, 0, `${label}: must not call Google`);
  }
});

Deno.test("missing Google key returns places_not_configured without reserving quota", async () => {
  const r = await go(autocomplete, happy, { GOOGLE_PLACES_API_KEY: null });
  assertEquals(r.status, 503);
  assertEquals(r.body.code, "places_not_configured");
  assertEquals(r.backend.reserveCalls.length, 0);
});

Deno.test("missing service role key fails closed with quota_unavailable and never calls Google", async () => {
  const r = await go(autocomplete, happy, { SUPABASE_SERVICE_ROLE_KEY: null });
  assertEquals(r.status, 503);
  assertEquals(r.body.code, "quota_unavailable");
  assertEquals(r.backend.providerCalls.length, 0);
});

// --- reservation ------------------------------------------------------------------------------

Deno.test("the reservation uses the service role key, the verified user id, the action and the shared policy", async () => {
  for (const body of [autocomplete, details, nearby]) {
    const r = await go(body, happy);
    assertEquals(r.status, 200, body.action);
    assertEquals(r.backend.reserveCalls.length, 1);
    const call = r.backend.reserveCalls[0];
    assertEquals(call.headers["authorization"], `Bearer ${SERVICE_KEY}`);
    assertEquals(call.body, {
      p_user_id: USER_ID, p_provider: "google_places", p_action: body.action,
      p_success_limit: 120, p_attempt_limit: 200, p_cooldown_seconds: 0, p_max_in_flight: 3,
      p_global_daily_limit: 2000, p_stale_seconds: 60
    });
  }
});

Deno.test("PLACES_GLOBAL_DAILY_LIMIT overrides the global budget", async () => {
  const r = await go(autocomplete, happy, { PLACES_GLOBAL_DAILY_LIMIT: "15" });
  assertEquals(r.backend.reserveCalls[0].body.p_global_daily_limit, 15);
});

for (const reason of ["global_budget", "daily_limit", "cooldown", "in_progress", "attempt_limit"]) {
  Deno.test(`a ${reason} denial returns 429 with code "${reason}", Retry-After, and never calls Google`, async () => {
    for (const body of [autocomplete, details, nearby]) {
      const r = await go(body, (b) => {
        happy(b);
        b.reserve = () => ({ body: { allowed: false, reason, retry_after_seconds: 90 } });
      });
      assertEquals(r.status, 429, body.action);
      assertEquals(r.body.code, reason);
      assertEquals(r.body.retryAfterSeconds, 90);
      assertEquals(r.response.headers.get("Retry-After"), "90");
      assertEquals(r.backend.providerCalls.length, 0, `${body.action}: Google must not be called`);
      assertEquals(r.backend.finishCalls.length, 0);
    }
  });
}

Deno.test("a failing reservation RPC fails closed: 503 quota_unavailable, Google never called", async () => {
  for (const reply of [
    { status: 500, body: { code: "XX000", message: "boom" } },
    { status: 404, body: { code: "PGRST202", message: "function not found" } },
    { status: 200, body: null },
    new Error("connection reset")
  ]) {
    const r = await go(details, (b) => {
      happy(b);
      b.reserve = () => reply as any;
    });
    assertEquals(r.status, 503, JSON.stringify(reply));
    assertEquals(r.body.code, "quota_unavailable");
    assertEquals(r.backend.providerCalls.length, 0);
    assertEquals(r.backend.finishCalls.length, 0);
  }
});

// --- success and settlement --------------------------------------------------------------------

Deno.test("autocomplete: one Google call, suggestions returned, reservation settled once as succeeded", async () => {
  const r = await go(autocomplete, (b) => {
    happy(b);
    b.reserve = () => ({ body: { allowed: true, reservation_id: "res-9" } });
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.suggestions, [{ id: "p1", name: "Louvre Museum", provider: "google" }]);
  assertEquals(r.backend.providerCalls.length, 1);
  assertEquals(r.backend.providerCalls[0].headers["x-goog-api-key"], "places-key");
  assertEquals(r.backend.providerCalls[0].body.sessionToken, "tok-1");
  assertEquals(r.backend.finishCalls.length, 1);
  assertEquals(r.backend.finishCalls[0].body, { p_reservation_id: "res-9", p_succeeded: true, p_failure_reason: null });
});

Deno.test("details and nearby return normalized places and settle once as succeeded", async () => {
  const d = await go(details, happy);
  assertEquals(d.status, 200);
  assertEquals(d.body.place.name, "Louvre");
  assertEquals(d.body.place.rating, 4.7);
  assertEquals(d.backend.providerCalls[0].path, "/v1/places/ChIJ-louvre");
  assertEquals(d.backend.finishCalls.map((c) => c.body.p_succeeded), [true]);

  const n = await go(nearby, happy);
  assertEquals(n.status, 200);
  assertEquals(n.body.places.length, 1);
  assertEquals(n.backend.providerCalls[0].path, "/v1/places:searchNearby");
  assertEquals(n.backend.finishCalls.map((c) => c.body.p_succeeded), [true]);
});

const failures: Array<{ name: string; reply: any; reason: string }> = [
  { name: "Google quota (429)", reply: { status: 429, body: { error: { message: "rate" } } }, reason: "provider_quota" },
  { name: "Google key rejected (403)", reply: { status: 403, body: {} }, reason: "provider_auth" },
  { name: "Google rejects the request (400)", reply: { status: 400, body: {} }, reason: "provider_rejected" },
  { name: "Google outage (500)", reply: { status: 500, body: {} }, reason: "provider_error" },
  { name: "network failure", reply: new TypeError("fetch failed"), reason: "provider_error" },
  { name: "timeout", reply: new DOMException("aborted", "AbortError"), reason: "timeout" }
];

for (const failure of failures) {
  Deno.test(`provider failure (${failure.name}) settles the reservation once as failed (${failure.reason})`, async () => {
    for (const body of [autocomplete, details, nearby]) {
      const r = await go(body, (b) => {
        b.provider = () => failure.reply;
        b.reserve = () => ({ body: { allowed: true, reservation_id: "res-3" } });
      });
      assert(r.status >= 400, `${body.action} must be an error response, got ${r.status}`);
      assertEquals(r.backend.finishCalls.length, 1, `${body.action}: settled exactly once`);
      assertEquals(r.backend.finishCalls[0].body, { p_reservation_id: "res-3", p_succeeded: false, p_failure_reason: failure.reason });
    }
  });
}

Deno.test("a failure while settling does not turn a successful search into an error", async () => {
  const r = await go(autocomplete, (b) => {
    happy(b);
    b.finish = () => ({ status: 500, body: { message: "db down" } });
  });
  assertEquals(r.status, 200);
  assertEquals(r.backend.finishCalls.length, 1);
});

Deno.test("upstream error details are not leaked to the client", async () => {
  const r = await go(details, (b) => {
    b.provider = () => ({ status: 500, body: { error: { message: "SECRET-INTERNAL-DETAIL api key=abc" } } });
  });
  assert(!JSON.stringify(r.body).includes("SECRET-INTERNAL-DETAIL"));
});

// --- upstream failures map to meaningful client responses ---------------------------------------
// 429 stays reserved for the user's own quota; Google's own 429 must not look like it.

const mappings: Array<{ name: string; reply: any; status: number; code: string }> = [
  { name: "Google 429", reply: { status: 429, body: { error: { message: "Quota exceeded for project 123" } } }, status: 503, code: "provider_rate_limited" },
  { name: "Google 401", reply: { status: 401, body: { error: { message: "API keys are not supported" } } }, status: 503, code: "provider_unavailable" },
  { name: "Google 403 (key rejected or API disabled)", reply: { status: 403, body: { error: { message: "Places API has not been used in project 123" } } }, status: 503, code: "provider_unavailable" },
  { name: "Google 504", reply: { status: 504, body: {} }, status: 504, code: "provider_timeout" },
  { name: "request timeout (abort)", reply: new DOMException("aborted", "AbortError"), status: 504, code: "provider_timeout" },
  { name: "network failure", reply: new TypeError("fetch failed"), status: 504, code: "provider_timeout" },
  { name: "Google 500", reply: { status: 500, body: {} }, status: 502, code: "provider_error" },
  { name: "Google 503", reply: { status: 503, body: {} }, status: 502, code: "provider_error" },
  { name: "Google 400", reply: { status: 400, body: { error: { message: "Invalid argument" } } }, status: 502, code: "provider_error" }
];

for (const mapping of mappings) {
  Deno.test(`${mapping.name} reaches the client as ${mapping.status} ${mapping.code}`, async () => {
    for (const body of [autocomplete, details, nearby]) {
      const r = await go(body, (b) => {
        b.provider = () => mapping.reply;
        b.reserve = () => ({ body: { allowed: true, reservation_id: "res-4" } });
      });
      assertEquals(r.status, mapping.status, body.action);
      assertEquals(r.body.code, mapping.code, body.action);
      assertEquals(Object.keys(r.body).sort(), ["code", "error"], "only a fixed message and code are exposed");
      assertEquals(r.backend.finishCalls.length, 1, `${body.action}: settled exactly once`);
      assertEquals(r.backend.finishCalls[0].body.p_succeeded, false);
    }
  });
}

Deno.test("an upstream 429 is a 503 provider_rate_limited, never the user-quota 429, and leaks nothing", async () => {
  const r = await go(details, (b) => {
    b.provider = () => ({ status: 429, body: { error: { message: "SECRET-INTERNAL-DETAIL project 123 key=abc" } } });
  });
  assertEquals(r.status, 503);
  assertEquals(r.response.headers.get("Retry-After"), null);
  assert(!JSON.stringify(r.body).includes("SECRET-INTERNAL-DETAIL"));
  for (const quotaCode of ["global_budget", "daily_limit", "cooldown", "in_progress", "attempt_limit"]) {
    assert(r.body.code !== quotaCode);
  }
});
