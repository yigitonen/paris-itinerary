import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUOTA_POLICIES,
  denialResponse,
  evaluateReservation,
  failureReasonFor,
  quotaPolicy,
  reservationParams
} from './quota.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();
const row = (status, seconds) => ({ status, createdAt: ago(seconds) });
const HOUR = 3600;
const gemini = QUOTA_POLICIES.gemini_plan;
const places = QUOTA_POLICIES.google_places;
const check = (policy, userRows = [], globalCount = 0) => evaluateReservation(policy, { userRows, globalCount }, NOW);

test('an idle user is allowed', () => {
  assert.deepEqual(check(gemini), { allowed: true, reason: null, retryAfterSeconds: 0 });
});

test('a plan already running blocks a second one', () => {
  const result = check(gemini, [row('reserved', 30)]);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'in_progress');
  // oldest reserved + 180 second stale window - now
  assert.equal(result.retryAfterSeconds, 150);
});

test('the cooldown follows the last attempt, including a failed one', () => {
  const afterSuccess = check(gemini, [row('succeeded', 20)]);
  assert.equal(afterSuccess.reason, 'cooldown');
  assert.equal(afterSuccess.retryAfterSeconds, 40);
  const afterFailure = check(gemini, [row('failed', 20)]);
  assert.equal(afterFailure.reason, 'cooldown');
  assert.equal(afterFailure.retryAfterSeconds, 40);
  assert.equal(check(gemini, [row('succeeded', 60)]).allowed, true);
  assert.equal(check(gemini, [row('succeeded', 59.5)]).retryAfterSeconds, 1);
});

test('three successful plans in 24 hours reach the daily limit', () => {
  const result = check(gemini, [row('succeeded', 10 * HOUR), row('succeeded', 5 * HOUR), row('succeeded', 3 * HOUR)]);
  assert.equal(result.reason, 'daily_limit');
  // oldest counted row + 24h - now
  assert.equal(result.retryAfterSeconds, 14 * HOUR);
});

test('ten attempts in 24 hours reach the attempt limit', () => {
  const rows = [row('failed', 20 * HOUR), ...Array.from({ length: 9 }, (_, index) => row('failed', (2 + index) * HOUR))];
  const result = check(gemini, rows);
  assert.equal(result.reason, 'attempt_limit');
  assert.equal(result.retryAfterSeconds, 4 * HOUR);
});

test('the global daily budget pauses everyone until UTC midnight', () => {
  const result = check(gemini, [], 200);
  assert.equal(result.reason, 'global_budget');
  assert.equal(result.retryAfterSeconds, 12 * HOUR);
  assert.equal(check(gemini, [], 199).allowed, true);
  // One second before midnight still waits at least a second.
  const lateNow = Date.UTC(2026, 9, 1, 23, 59, 59);
  assert.equal(evaluateReservation(gemini, { userRows: [], globalCount: 200 }, lateNow).retryAfterSeconds, 1);
});

test('denial reasons are checked in a fixed order', () => {
  const everything = [
    row('reserved', 10),
    row('succeeded', 6 * HOUR),
    row('succeeded', 5 * HOUR),
    row('succeeded', 4 * HOUR),
    ...Array.from({ length: 6 }, (_, index) => row('failed', (7 + index) * HOUR))
  ];
  assert.equal(check(gemini, everything, 500).reason, 'in_progress');
  const withoutReserved = everything.slice(1);
  withoutReserved.push(row('failed', 30));
  assert.equal(check(gemini, withoutReserved, 500).reason, 'cooldown');
  const withoutCooldown = everything.slice(1);
  assert.equal(check(gemini, withoutCooldown, 500).reason, 'daily_limit');
  const attemptsOnly = Array.from({ length: 10 }, (_, index) => row('failed', (2 + index) * HOUR));
  assert.equal(check(gemini, attemptsOnly, 500).reason, 'attempt_limit');
  assert.equal(check(gemini, [], 500).reason, 'global_budget');
});

test('a stale reservation does not block but still counts as an attempt', () => {
  assert.equal(check(gemini, [row('reserved', 200)]).allowed, true);
  const rows = [row('reserved', 200), ...Array.from({ length: 9 }, (_, index) => row('failed', (2 + index) * HOUR))];
  assert.equal(check(gemini, rows).reason, 'attempt_limit');
  // A stale reservation is a failure, so it never counts toward the success limit.
  const successLike = [row('reserved', 200), row('succeeded', 5 * HOUR), row('succeeded', 6 * HOUR)];
  assert.equal(check(gemini, successLike).allowed, true);
});

test('failed rows count toward attempts but not toward the success limit', () => {
  const failures = Array.from({ length: 5 }, (_, index) => row('failed', (1 + index) * HOUR));
  assert.equal(check(gemini, failures).allowed, true);
  const tooMany = Array.from({ length: 10 }, (_, index) => row('failed', (1 + index) * HOUR));
  assert.equal(check(gemini, tooMany).reason, 'attempt_limit');
});

test('place search allows three searches at once and has no cooldown', () => {
  assert.equal(check(places, [row('reserved', 5), row('reserved', 4)]).allowed, true);
  const three = check(places, [row('reserved', 10), row('reserved', 5), row('reserved', 4)]);
  assert.equal(three.reason, 'in_progress');
  assert.equal(three.retryAfterSeconds, 50);
  assert.equal(check(places, [row('succeeded', 1)]).allowed, true);
  assert.equal(check(places, Array.from({ length: 120 }, (_, index) => row('succeeded', 100 + index))).reason, 'daily_limit');
  assert.equal(check(places, [], 2000).reason, 'global_budget');
});

test('global limits can be overridden by a positive integer', () => {
  assert.equal(quotaPolicy('gemini_plan', { AI_GLOBAL_DAILY_LIMIT: '50' }).globalDailyLimit, 50);
  assert.equal(quotaPolicy('google_places', { PLACES_GLOBAL_DAILY_LIMIT: '75' }).globalDailyLimit, 75);
  for (const bad of ['abc', '0', '-1', '', '1.5', undefined]) {
    assert.equal(quotaPolicy('gemini_plan', { AI_GLOBAL_DAILY_LIMIT: bad }).globalDailyLimit, 200);
    assert.equal(quotaPolicy('google_places', { PLACES_GLOBAL_DAILY_LIMIT: bad }).globalDailyLimit, 2000);
  }
  assert.equal(quotaPolicy('gemini_plan').globalDailyLimit, 200);
  assert.equal(QUOTA_POLICIES.gemini_plan.globalDailyLimit, 200, 'overrides must not mutate the defaults');
  assert.throws(() => quotaPolicy('nope'));
});

test('reservation params use exactly the nine RPC argument names', () => {
  const params = reservationParams('user-1', 'gemini_plan', 'plan', gemini);
  assert.deepEqual(params, {
    p_user_id: 'user-1',
    p_provider: 'gemini_plan',
    p_action: 'plan',
    p_success_limit: 3,
    p_attempt_limit: 10,
    p_cooldown_seconds: 60,
    p_max_in_flight: 1,
    p_global_daily_limit: 200,
    p_stale_seconds: 180
  });
  assert.equal(reservationParams('u', 'google_places', 'x'.repeat(40), places).p_action.length, 20);
});

test('denial responses are 429s with Retry-After and a stable code', () => {
  const plan = denialResponse('gemini_plan', { allowed: false, reason: 'cooldown', retryAfterSeconds: 42 });
  assert.equal(plan.status, 429);
  assert.deepEqual(plan.headers, { 'Retry-After': '42' });
  assert.deepEqual(plan.body, { error: 'Yeni bir AI planı oluşturmadan önce bir dakika bekle.', code: 'cooldown', retryAfterSeconds: 42 });
  const turkish = {
    in_progress: 'Önceki AI planın hâlâ hazırlanıyor. Bitince yeniden dene.',
    daily_limit: 'Ücretsiz AI planı günlük sınırına ulaştın. 24 saat sonra yeniden deneyebilirsin.',
    attempt_limit: 'Bugün çok fazla AI planı denemesi yapıldı. Daha sonra yeniden dene.',
    global_budget: 'Roamly’nin bugünkü AI planlama kapasitesi doldu. Yarın yeniden dene veya boş planla devam et.'
  };
  for (const [reason, message] of Object.entries(turkish)) {
    assert.equal(denialResponse('gemini_plan', { allowed: false, reason, retryAfterSeconds: 5 }).body.error, message);
  }
  const english = {
    in_progress: 'Another place search is still running.',
    daily_limit: 'Daily place search limit reached.',
    attempt_limit: 'Too many place searches today.',
    global_budget: 'Place search is paused for today.'
  };
  for (const [reason, message] of Object.entries(english)) {
    const result = denialResponse('google_places', { allowed: false, reason, retryAfterSeconds: 9 });
    assert.equal(result.body.error, message);
    assert.equal(result.body.code, reason);
    assert.equal(result.headers['Retry-After'], '9');
  }
});

test('failure reasons are short stable labels', () => {
  assert.equal(failureReasonFor({ status: 429 }), 'provider_quota');
  assert.equal(failureReasonFor({ status: 403 }), 'provider_auth');
  assert.equal(failureReasonFor({ status: 400 }), 'provider_rejected');
  assert.equal(failureReasonFor({ status: 504 }), 'timeout');
  assert.equal(failureReasonFor(Object.assign(new Error('x'), { name: 'AbortError' })), 'timeout');
  assert.equal(failureReasonFor(new Error('Google Maps could not ground the route')), 'grounding');
  assert.equal(failureReasonFor(new Error('Planner returned invalid JSON')), 'invalid_output');
  assert.equal(failureReasonFor(new Error('Planner response has the wrong number of days')), 'invalid_output');
  assert.equal(failureReasonFor({ status: 500 }), 'provider_error');
  assert.equal(failureReasonFor(null), 'provider_error');
  assert.equal(failureReasonFor('boom'), 'provider_error');
});

const migration = readFileSync(new URL('../../migrations/20261001090000_atomic_provider_usage.sql', import.meta.url), 'utf8');

test('the migration locks, checks and grants as designed', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /pg_advisory_xact_lock/);
  for (const reason of ['in_progress', 'cooldown', 'daily_limit', 'attempt_limit', 'global_budget']) {
    assert.ok(migration.includes(`'${reason}'`), `missing reason ${reason}`);
  }
  for (const name of ['reserve_provider_usage', 'finish_provider_usage']) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${name}\\([^;]*from public, anon, authenticated;`, 'i'));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([^;]*to service_role;`, 'i'));
  }
  assert.doesNotMatch(migration, /grant\s+execute[^;]*\bto\b[^;]*\b(authenticated|anon|public)\b/i);
  assert.match(migration, /revoke all on table public\.provider_usage from public, anon, authenticated;/i);
  assert.match(migration, /enable row level security/i);
});

test('the migration signature matches the client parameters', () => {
  const start = migration.indexOf('function public.reserve_provider_usage(');
  const signature = migration.slice(start, migration.indexOf(')', start));
  const names = [...signature.matchAll(/\bp_[a-z_]+/g)].map((match) => match[0]);
  assert.deepEqual(names, Object.keys(reservationParams('u', 'gemini_plan', 'plan', gemini)));
});

for (const [file, firstProviderCall] of [['../plan-trip/index.ts', 'geminiRequest(generatePath'], ['../places/index.ts', 'google(']]) {
  test(`${file} reserves quota before the first provider call and finishes it`, () => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('Deno.serve('));
    const reserve = handler.indexOf('rpc("reserve_provider_usage"');
    const provider = handler.indexOf(firstProviderCall);
    assert.ok(reserve > 0, 'reserve_provider_usage RPC missing');
    assert.ok(provider > reserve, 'provider call must come after the reservation');
    assert.match(source, /rpc\("finish_provider_usage"/);
    assert.match(source, /finish\(true\)/);
    assert.match(source, /finish\(false, failureReasonFor\(/);
    assert.doesNotMatch(source, /select\("id", \{ count: "exact"/);
    assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  });
}
