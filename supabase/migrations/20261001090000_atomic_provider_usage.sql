-- Atomic usage ledger for paid providers (Gemini plans, Google Places).
--
-- Replaces the count-then-insert checks in the Edge Functions, which let
-- concurrent requests all pass the limit and never recorded failures. A caller
-- now reserves a slot with reserve_provider_usage before calling the provider
-- and settles it with finish_provider_usage afterwards.
--
-- Only successful rows use up a user's allowance; failed rows still count as
-- attempts. History in ai_plan_requests and place_search_requests is not
-- carried over, so usage recorded there stops counting after this deploys.

create table public.provider_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gemini_plan', 'google_places')),
  action text not null default '' check (char_length(action) <= 20),
  status text not null default 'reserved' check (status in ('reserved', 'succeeded', 'failed')),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 60),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index provider_usage_user_idx on public.provider_usage (provider, user_id, created_at desc);
create index provider_usage_global_idx on public.provider_usage (provider, created_at desc);

alter table public.provider_usage enable row level security;

revoke all on table public.provider_usage from public, anon, authenticated;
grant all on table public.provider_usage to service_role;

create policy "clients cannot access provider usage"
on public.provider_usage for all
to anon, authenticated
using (false) with check (false);

comment on table public.provider_usage is
  'Server-only ledger of paid provider calls (Gemini plans, Google Places). Written through reserve_provider_usage and finish_provider_usage; supersedes ai_plan_requests and place_search_requests.';

create or replace function public.reserve_provider_usage(
  p_user_id uuid,
  p_provider text,
  p_action text,
  p_success_limit int,
  p_attempt_limit int,
  p_cooldown_seconds int,
  p_max_in_flight int,
  p_global_daily_limit int,
  p_stale_seconds int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_day_start timestamptz;
  v_succeeded int;
  v_reserved int;
  v_total int;
  v_last timestamptz;
  v_oldest_reserved timestamptz;
  v_oldest_counted timestamptz;
  v_oldest_any timestamptz;
  v_global int;
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'reserve_provider_usage: user id is required';
  end if;
  if p_provider is null or p_provider not in ('gemini_plan', 'google_places') then
    raise exception 'reserve_provider_usage: unknown provider %', p_provider;
  end if;
  if p_success_limit is null or p_attempt_limit is null or p_cooldown_seconds is null
     or p_max_in_flight is null or p_global_daily_limit is null or p_stale_seconds is null
     or p_stale_seconds < 1 then
    raise exception 'reserve_provider_usage: limits are required';
  end if;

  -- One lock per provider serializes reservations, so the per-user and global
  -- counts below are exact. The lock is released when the transaction ends.
  perform pg_advisory_xact_lock(hashtextextended('roamly_provider_usage:' || p_provider, 0));

  v_now := clock_timestamp();

  -- Reservations that never finished (crashed or timed-out function) expire.
  update public.provider_usage
  set status = 'failed', failure_reason = 'expired', finished_at = v_now
  where provider = p_provider
    and status = 'reserved'
    and created_at < v_now - make_interval(secs => p_stale_seconds);

  select
    count(*) filter (where status = 'succeeded'),
    count(*) filter (where status = 'reserved'),
    count(*),
    max(created_at),
    min(created_at) filter (where status = 'reserved'),
    min(created_at) filter (where status in ('succeeded', 'reserved')),
    min(created_at)
  into v_succeeded, v_reserved, v_total, v_last, v_oldest_reserved, v_oldest_counted, v_oldest_any
  from public.provider_usage
  where provider = p_provider
    and user_id = p_user_id
    and created_at >= v_now - interval '24 hours';

  v_day_start := date_trunc('day', v_now at time zone 'utc') at time zone 'utc';
  select count(*) into v_global
  from public.provider_usage
  where provider = p_provider and created_at >= v_day_start;

  if v_reserved >= p_max_in_flight then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'in_progress',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (
        v_oldest_reserved + make_interval(secs => p_stale_seconds) - v_now
      ))))::int
    );
  end if;

  if p_cooldown_seconds > 0 and v_last is not null
     and v_now < v_last + make_interval(secs => p_cooldown_seconds) then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'cooldown',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (
        v_last + make_interval(secs => p_cooldown_seconds) - v_now
      ))))::int
    );
  end if;

  if v_succeeded + v_reserved >= p_success_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'daily_limit',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (
        v_oldest_counted + interval '24 hours' - v_now
      ))))::int
    );
  end if;

  if v_total >= p_attempt_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'attempt_limit',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (
        v_oldest_any + interval '24 hours' - v_now
      ))))::int
    );
  end if;

  if v_global >= p_global_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'global_budget',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (
        (v_day_start + interval '1 day') - v_now
      ))))::int
    );
  end if;

  insert into public.provider_usage (user_id, provider, action, status, created_at)
  values (p_user_id, p_provider, left(coalesce(p_action, ''), 20), 'reserved', v_now)
  returning id into v_id;

  return jsonb_build_object('allowed', true, 'reservation_id', v_id);
end;
$$;

create or replace function public.finish_provider_usage(
  p_reservation_id uuid,
  p_succeeded boolean,
  p_failure_reason text default null
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.provider_usage
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      failure_reason = case
        when p_succeeded then null
        else left(coalesce(p_failure_reason, 'provider_error'), 60)
      end,
      finished_at = clock_timestamp()
  where id = p_reservation_id and status = 'reserved';
  return found;
end;
$$;

revoke execute on function public.reserve_provider_usage(uuid, text, text, int, int, int, int, int, int)
  from public, anon, authenticated;
grant execute on function public.reserve_provider_usage(uuid, text, text, int, int, int, int, int, int)
  to service_role;

revoke execute on function public.finish_provider_usage(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.finish_provider_usage(uuid, boolean, text)
  to service_role;

comment on function public.reserve_provider_usage(uuid, text, text, int, int, int, int, int, int) is
  'Atomically checks in-flight, cooldown, daily success, attempt and global limits for one provider and, when allowed, inserts a reserved row. Service role only.';
comment on function public.finish_provider_usage(uuid, boolean, text) is
  'Settles a reserved provider_usage row as succeeded or failed. Returns false when the reservation was missing or already settled. Service role only.';

comment on table public.ai_plan_requests is
  'Superseded by provider_usage; no longer written or read by the Edge Functions.';
comment on table public.place_search_requests is
  'Superseded by provider_usage; no longer written or read by the Edge Functions.';
