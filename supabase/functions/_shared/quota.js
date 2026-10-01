// Shared quota rules for the paid-provider Edge Functions (plan-trip, places).
//
// The database function public.reserve_provider_usage enforces these rules
// atomically. evaluateReservation below is the executable specification of the
// same checks, in the same order, so the rules can be tested without a database.

const DAY_SECONDS = 24 * 60 * 60;

export const QUOTA_POLICIES = Object.freeze({
  gemini_plan: Object.freeze({
    successLimit: 3,
    attemptLimit: 10,
    cooldownSeconds: 60,
    maxInFlight: 1,
    globalDailyLimit: 200,
    staleSeconds: 180
  }),
  google_places: Object.freeze({
    successLimit: 120,
    attemptLimit: 200,
    cooldownSeconds: 0,
    maxInFlight: 3,
    globalDailyLimit: 2000,
    staleSeconds: 60
  })
});

const GLOBAL_LIMIT_ENV = { gemini_plan: 'AI_GLOBAL_DAILY_LIMIT', google_places: 'PLACES_GLOBAL_DAILY_LIMIT' };

export function quotaPolicy(provider, env = {}) {
  const base = QUOTA_POLICIES[provider];
  if (!base) throw new Error(`Unknown quota provider: ${provider}`);
  const override = String(env?.[GLOBAL_LIMIT_ENV[provider]] ?? '').trim();
  const globalDailyLimit = /^\d{1,9}$/.test(override) && Number(override) > 0 ? Number(override) : base.globalDailyLimit;
  return { ...base, globalDailyLimit };
}

// Keys must match the argument names of public.reserve_provider_usage.
export function reservationParams(userId, provider, action, policy) {
  return {
    p_user_id: userId,
    p_provider: provider,
    p_action: String(action || '').slice(0, 20),
    p_success_limit: policy.successLimit,
    p_attempt_limit: policy.attemptLimit,
    p_cooldown_seconds: policy.cooldownSeconds,
    p_max_in_flight: policy.maxInFlight,
    p_global_daily_limit: policy.globalDailyLimit,
    p_stale_seconds: policy.staleSeconds
  };
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : Date.parse(value);
}

function retryAfter(milliseconds) {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

export function evaluateReservation(policy, { userRows = [], globalCount = 0 } = {}, now = Date.now()) {
  const nowMs = toMs(now);
  const staleBefore = nowMs - policy.staleSeconds * 1000;
  const rows = userRows
    .map((row) => {
      const createdMs = toMs(row.createdAt);
      // Reservations that outlived the stale window were abandoned: failed, but still an attempt.
      const status = row.status === 'reserved' && createdMs < staleBefore ? 'failed' : row.status;
      return { status, createdMs };
    })
    .filter((row) => row.createdMs >= nowMs - DAY_SECONDS * 1000);

  const reserved = rows.filter((row) => row.status === 'reserved');
  const counted = rows.filter((row) => row.status === 'succeeded' || row.status === 'reserved');
  const oldest = (list) => Math.min(...list.map((row) => row.createdMs));
  const deny = (reason, milliseconds) => ({ allowed: false, reason, retryAfterSeconds: retryAfter(milliseconds) });

  if (reserved.length >= policy.maxInFlight) {
    return deny('in_progress', oldest(reserved) + policy.staleSeconds * 1000 - nowMs);
  }
  if (policy.cooldownSeconds > 0 && rows.length) {
    const last = Math.max(...rows.map((row) => row.createdMs));
    if (nowMs < last + policy.cooldownSeconds * 1000) return deny('cooldown', last + policy.cooldownSeconds * 1000 - nowMs);
  }
  if (counted.length >= policy.successLimit) {
    return deny('daily_limit', oldest(counted) + DAY_SECONDS * 1000 - nowMs);
  }
  if (rows.length >= policy.attemptLimit) {
    return deny('attempt_limit', oldest(rows) + DAY_SECONDS * 1000 - nowMs);
  }
  if (globalCount >= policy.globalDailyLimit) {
    const nextMidnight = (Math.floor(nowMs / 86_400_000) + 1) * 86_400_000;
    return deny('global_budget', nextMidnight - nowMs);
  }
  return { allowed: true, reason: null, retryAfterSeconds: 0 };
}

const DENIAL_MESSAGES = {
  gemini_plan: {
    in_progress: 'Önceki AI planın hâlâ hazırlanıyor. Bitince yeniden dene.',
    cooldown: 'Yeni bir AI planı oluşturmadan önce bir dakika bekle.',
    daily_limit: 'Ücretsiz AI planı günlük sınırına ulaştın. 24 saat sonra yeniden deneyebilirsin.',
    attempt_limit: 'Bugün çok fazla AI planı denemesi yapıldı. Daha sonra yeniden dene.',
    global_budget: 'Roamly’nin bugünkü AI planlama kapasitesi doldu. Yarın yeniden dene veya boş planla devam et.'
  },
  google_places: {
    in_progress: 'Another place search is still running.',
    cooldown: 'Please wait a moment before searching again.',
    daily_limit: 'Daily place search limit reached.',
    attempt_limit: 'Too many place searches today.',
    global_budget: 'Place search is paused for today.'
  }
};

export function denialResponse(provider, result) {
  const seconds = Math.max(1, Number(result?.retryAfterSeconds) || 1);
  const reason = result?.reason || 'daily_limit';
  const messages = DENIAL_MESSAGES[provider] || DENIAL_MESSAGES.google_places;
  return {
    status: 429,
    headers: { 'Retry-After': String(seconds) },
    body: { error: messages[reason] || messages.daily_limit, code: reason, retryAfterSeconds: seconds }
  };
}

// Short, stable labels stored in provider_usage.failure_reason (max 60 chars).
export function failureReasonFor(error) {
  const status = Number(error?.status);
  const message = String(error?.message || '');
  if (status === 429) return 'provider_quota';
  if (status === 403) return 'provider_auth';
  if (status === 400) return 'provider_rejected';
  if (status === 504 || error?.name === 'AbortError') return 'timeout';
  if (/could not ground/i.test(message)) return 'grounding';
  if (/invalid JSON|Planner re(turned|sponse)|wrong number/i.test(message)) return 'invalid_output';
  return 'provider_error';
}
