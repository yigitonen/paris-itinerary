// Cross-checks between the SQL function, the shared quota module and the client.
// These catch renames that would silently break the reserve -> provider -> finish flow.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { QUOTA_POLICIES, denialResponse, reservationParams } from "../../functions/_shared/quota.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));

// The newest migration that (re)defines the quota functions is the one that is live.
const migrationsDir = new URL("supabase/migrations/", root);
const migrationName = [...Deno.readDirSync(migrationsDir)].map((e) => e.name).sort().reverse()
  .find((name) => Deno.readTextFileSync(new URL(name, migrationsDir)).includes("function public.reserve_provider_usage"));
assert(migrationName, "no migration defines reserve_provider_usage");
const migration = Deno.readTextFileSync(new URL(migrationName, migrationsDir));

function sqlParams(functionName: string): string[] {
  const match = migration.match(new RegExp(`create or replace function public\\.${functionName}\\(([\\s\\S]*?)\\)\\s*returns`));
  assert(match, `${functionName} not found in migration`);
  return match[1].split(",").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
}

Deno.test("reservationParams keys are exactly the arguments of reserve_provider_usage", () => {
  const policy = QUOTA_POLICIES.gemini_plan;
  const keys = Object.keys(reservationParams("u", "gemini_plan", "plan", policy)).sort();
  assertEquals(keys, sqlParams("reserve_provider_usage").sort());
});

Deno.test("both functions send the arguments finish_provider_usage declares", () => {
  const declared = sqlParams("finish_provider_usage").sort();
  assertEquals(declared, ["p_failure_reason", "p_reservation_id", "p_succeeded"]);
  for (const file of ["supabase/functions/plan-trip/index.ts", "supabase/functions/places/index.ts"]) {
    const source = read(file);
    for (const name of declared) assert(source.includes(name), `${file} does not pass ${name}`);
  }
});

Deno.test("every denial reason the database can return has a message for both providers and the client", () => {
  const reasons = [...migration.matchAll(/'reason',\s*'(\w+)'/g)].map((m) => m[1]).sort();
  assertEquals(reasons, ["attempt_limit", "cooldown", "daily_limit", "global_budget", "in_progress"]);

  const planner = read("src/planner.js");
  const block = planner.match(/const QUOTA_MESSAGES = \{([\s\S]*?)\n\};/);
  assert(block, "QUOTA_MESSAGES not found in src/planner.js");
  const clientCodes = [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]).sort();
  assertEquals(clientCodes, reasons, "src/planner.js QUOTA_MESSAGES must cover exactly the database reasons");

  for (const provider of ["gemini_plan", "google_places"]) {
    for (const reason of reasons) {
      const denial = denialResponse(provider, { allowed: false, reason, retryAfterSeconds: 42 });
      assertEquals(denial.status, 429);
      assertEquals(denial.body.code, reason);
      assertEquals(denial.headers["Retry-After"], "42");
      assert(denial.body.error.length > 0);
    }
  }
});

Deno.test("quota policies are sane", () => {
  for (const [provider, policy] of Object.entries(QUOTA_POLICIES) as Array<[string, Record<string, number>]>) {
    for (const [key, value] of Object.entries(policy)) {
      assert(Number.isInteger(value) && value >= 0, `${provider}.${key} must be a non-negative integer`);
      assert(value <= 2_147_483_647, `${provider}.${key} must fit a Postgres int`);
    }
    assert(policy.attemptLimit >= policy.successLimit, `${provider}: attemptLimit must not be below successLimit`);
    assert(policy.maxInFlight >= 1 && policy.staleSeconds >= 1, `${provider}: needs a positive in-flight cap and stale window`);
    assert(policy.globalDailyLimit >= policy.successLimit, `${provider}: global budget below one user's allowance`);
  }
  // The stale window must outlive the slowest upstream path, or live requests get expired mid-flight:
  // plan-trip makes two Gemini calls with a 38 s timeout each; places makes one 10 s call.
  assert(QUOTA_POLICIES.gemini_plan.staleSeconds > 2 * 38);
  assert(QUOTA_POLICIES.google_places.staleSeconds > 10);
});
