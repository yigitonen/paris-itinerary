-- Behaviour of public.reserve_provider_usage / public.finish_provider_usage:
-- limits stop exactly where they should, settle paths, expiry, rolling windows,
-- per-user vs global limits. Called as service_role, the only role allowed to.
-- (Concurrent callers are covered by test_concurrency.sh; grants by
-- test_provider_usage_privileges.sql.)
\set ON_ERROR_STOP on
begin;
\ir lib.sql

delete from public.provider_usage;  -- rolled back at the end; makes global counts deterministic

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset
select tests.make_user('bbbbbbbb-0000-4000-8000-00000000000b', 'b@example.test') as b \gset
select tests.make_user('cccccccc-0000-4000-8000-00000000000c', 'c@example.test') as c \gset

-- Wrapper with generous defaults so each case only states the limit under test.
create function tests.reserve(
  p_user uuid, p_provider text default 'gemini_plan',
  p_success int default 1000, p_attempt int default 1000, p_cooldown int default 0,
  p_inflight int default 1000, p_global int default 1000000, p_stale int default 180,
  p_action text default 'plan'
) returns jsonb language sql as $$
  select public.reserve_provider_usage(p_user, p_provider, p_action, p_success, p_attempt,
                                       p_cooldown, p_inflight, p_global, p_stale)
$$;

-- Reserve + settle in one step; returns the reservation result.
create function tests.use(p_user uuid, p_outcome boolean, p_provider text default 'gemini_plan',
                          p_success int default 1000, p_attempt int default 1000) returns jsonb
language plpgsql as $$
declare r jsonb;
begin
  r := tests.reserve(p_user, p_provider, p_success, p_attempt);
  if (r ->> 'allowed')::boolean then
    perform public.finish_provider_usage((r ->> 'reservation_id')::uuid, p_outcome,
                                         case when p_outcome then null else 'boom' end);
  end if;
  return r;
end $$;

-- Test-only helper to move history around (needs admin because clients/service
-- never rewrite the ledger).
create function tests.age(p_user uuid, p_interval interval, p_provider text default 'gemini_plan') returns void
language plpgsql as $$
begin
  update public.provider_usage set created_at = created_at - p_interval
  where user_id = p_user and provider = p_provider;
end $$;

-- Input validation --------------------------------------------------------------
select tests.as_service();
select tests.assert_denied($$select tests.reserve(null)$$, 'null user rejected', 'P0001');
select tests.assert_denied($$select tests.reserve('aaaaaaaa-0000-4000-8000-00000000000a', 'openai')$$, 'unknown provider rejected', 'P0001');
select tests.assert_denied($$select tests.reserve('aaaaaaaa-0000-4000-8000-00000000000a', null)$$, 'null provider rejected', 'P0001');
select tests.assert_denied($$select public.reserve_provider_usage('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan', 'x', null, 1, 0, 1, 1, 60)$$, 'null limit rejected', 'P0001');
select tests.assert_denied($$select tests.reserve('aaaaaaaa-0000-4000-8000-00000000000a', p_stale => 0)$$, 'stale_seconds < 1 rejected', 'P0001');
select tests.assert_denied($$select tests.reserve('99999999-0000-4000-8000-000000000099')$$, 'unknown user hits the FK', '23503');

-- Success limit: allowed exactly up to the limit, then daily_limit ------------------
do $$
declare i int; r jsonb; ok int := 0; u uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
begin
  for i in 1..8 loop
    r := tests.use(u, true, 'gemini_plan', 3, 1000);
    if (r ->> 'allowed')::boolean then ok := ok + 1; end if;
  end loop;
  perform tests.assert_eq(ok, 3, 'exactly success_limit reservations were allowed');
  r := tests.reserve(u, p_success => 3);
  perform tests.assert_eq(r ->> 'reason', 'daily_limit', 'reason after limit');
  perform tests.assert_eq((r ->> 'allowed')::boolean, false, 'allowed flag after limit');
  perform tests.assert_true((r ->> 'retry_after_seconds')::int between 1 and 86400, 'retry_after within 24h');
  perform tests.assert_true(not (r ? 'reservation_id'), 'no reservation id on denial');
  perform tests.assert_eq((select count(*) from public.provider_usage where user_id = u), 3::bigint, 'denied calls insert no rows');
end $$;

-- another user is unaffected by A's exhausted allowance
select tests.assert_eq((tests.reserve(:'b', p_success => 3) ->> 'allowed')::boolean, true, 'B unaffected by A limit');

-- A different provider has its own allowance for the same user
select tests.assert_eq((tests.reserve(:'a', 'google_places', p_success => 3) ->> 'allowed')::boolean, true, 'A can still use the other provider');

-- retry_after tracks the oldest counted row: age A's rows by 23h => ~1h left
select tests.as_admin();
select tests.age(:'a', interval '23 hours');
select tests.as_service();
select tests.assert_true((tests.reserve(:'a', p_success => 3) ->> 'retry_after_seconds')::int between 3500 and 3700, 'retry_after reflects oldest row');

-- ...and rows older than 24h stop counting entirely
select tests.as_admin();
select tests.age(:'a', interval '2 hours');
select tests.as_service();
select tests.assert_eq((tests.reserve(:'a', p_success => 3) ->> 'allowed')::boolean, true, 'rows older than 24h no longer count');

-- Failed attempts do not use the success allowance, but count toward attempt_limit ---
do $$
declare i int; r jsonb; u uuid := 'cccccccc-0000-4000-8000-00000000000c';
begin
  -- success_limit 2, attempt_limit 4: three failures leave both successes available.
  for i in 1..3 loop
    r := tests.use(u, false, 'gemini_plan', 2, 4);
    perform tests.assert_eq((r ->> 'allowed')::boolean, true, 'failure attempt ' || i || ' allowed');
  end loop;
  r := tests.use(u, true, 'gemini_plan', 2, 4);
  perform tests.assert_eq((r ->> 'allowed')::boolean, true, 'success after failures is allowed (failures do not use success quota)');
  -- 4 attempts used, only 1 success: the 5th attempt hits attempt_limit, not daily_limit
  r := tests.reserve(u, p_success => 2, p_attempt => 4);
  perform tests.assert_eq(r ->> 'reason', 'attempt_limit', 'attempt_limit reached');
  perform tests.assert_true((r ->> 'retry_after_seconds')::int between 1 and 86400, 'attempt_limit retry_after');
  perform tests.assert_eq((select count(*) from public.provider_usage where user_id = u and status = 'failed' and failure_reason = 'boom'), 3::bigint, 'failures recorded with reason');
end $$;

-- In-flight: second reservation is refused until the first settles ----------------
do $$
declare r1 jsonb; r2 jsonb; r3 jsonb; u uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
begin
  delete from public.provider_usage where user_id = u;  -- service_role has DELETE
  r1 := tests.reserve(u, p_inflight => 1);
  perform tests.assert_eq((r1 ->> 'allowed')::boolean, true, 'first reservation allowed');
  r2 := tests.reserve(u, p_inflight => 1);
  perform tests.assert_eq(r2 ->> 'reason', 'in_progress', 'second concurrent reservation refused');
  perform tests.assert_true((r2 ->> 'retry_after_seconds')::int between 1 and 180, 'in_progress retry_after bounded by stale window');
  perform tests.assert_eq(public.finish_provider_usage((r1 ->> 'reservation_id')::uuid, false, 'x'), true, 'finish returns true');
  r3 := tests.reserve(u, p_inflight => 1);
  perform tests.assert_eq((r3 ->> 'allowed')::boolean, true, 'slot freed after finish');
  -- an in-flight slot counts toward the success limit immediately
  perform public.finish_provider_usage((r3 ->> 'reservation_id')::uuid, true, null);
  delete from public.provider_usage where user_id = u;
  perform tests.reserve(u, p_success => 1);
  perform tests.assert_eq(tests.reserve(u, p_success => 1) ->> 'reason', 'daily_limit', 'reserved (unsettled) rows use the success allowance');
end $$;

-- Cooldown ------------------------------------------------------------------------
do $$
declare r jsonb; u uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
begin
  delete from public.provider_usage where user_id = u;
  r := tests.reserve(u, p_cooldown => 60);
  perform tests.assert_eq((r ->> 'allowed')::boolean, true, 'first call passes cooldown');
  perform public.finish_provider_usage((r ->> 'reservation_id')::uuid, false, 'x');
  r := tests.reserve(u, p_cooldown => 60);
  perform tests.assert_eq(r ->> 'reason', 'cooldown', 'cooldown applies after a failed attempt too');
  perform tests.assert_true((r ->> 'retry_after_seconds')::int between 1 and 60, 'cooldown retry_after <= cooldown');
  perform tests.assert_eq((tests.reserve(u, p_cooldown => 0) ->> 'allowed')::boolean, true, 'cooldown 0 disables it');
end $$;
select tests.as_admin();
select tests.age(:'b', interval '61 seconds');
select tests.as_service();
select tests.assert_eq((tests.reserve(:'b', p_cooldown => 60, p_inflight => 5) ->> 'allowed')::boolean, true, 'allowed again once the cooldown elapsed');

-- Check precedence (same order as quota.js evaluateReservation) ---------------------
do $$
declare r jsonb; u uuid := 'cccccccc-0000-4000-8000-00000000000c';
begin
  delete from public.provider_usage where user_id = u;
  r := tests.reserve(u);   -- one reserved row
  -- in_progress beats cooldown, daily_limit, attempt_limit and global
  perform tests.assert_eq(tests.reserve(u, p_success => 1, p_attempt => 1, p_cooldown => 60, p_inflight => 1, p_global => 1) ->> 'reason', 'in_progress', 'in_progress first');
  perform tests.assert_eq(tests.reserve(u, p_success => 1, p_attempt => 1, p_cooldown => 60, p_inflight => 5, p_global => 1) ->> 'reason', 'cooldown', 'cooldown second');
  perform tests.assert_eq(tests.reserve(u, p_success => 1, p_attempt => 1, p_cooldown => 0, p_inflight => 5, p_global => 1) ->> 'reason', 'daily_limit', 'daily_limit third');
  perform tests.assert_eq(tests.reserve(u, p_success => 5, p_attempt => 1, p_cooldown => 0, p_inflight => 5, p_global => 1) ->> 'reason', 'attempt_limit', 'attempt_limit fourth');
  perform tests.assert_eq(tests.reserve(u, p_success => 5, p_attempt => 5, p_cooldown => 0, p_inflight => 5, p_global => 1) ->> 'reason', 'global_budget', 'global_budget last');
end $$;

-- Global daily budget: shared across users, per provider, resets at UTC midnight ----
do $$
declare r jsonb; i int; ok int := 0; ua uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
        ub uuid := 'bbbbbbbb-0000-4000-8000-00000000000b'; uc uuid := 'cccccccc-0000-4000-8000-00000000000c';
        users uuid[] := array['aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'cccccccc-0000-4000-8000-00000000000c'];
begin
  delete from public.provider_usage;
  for i in 1..8 loop
    r := tests.reserve(users[1 + (i % 3)], p_global => 5);
    if (r ->> 'allowed')::boolean then ok := ok + 1; end if;
  end loop;
  perform tests.assert_eq(ok, 5, 'exactly global_daily_limit reservations allowed across users');
  r := tests.reserve(uc, p_global => 5);
  perform tests.assert_eq(r ->> 'reason', 'global_budget', 'global_budget reason');
  perform tests.assert_true((r ->> 'retry_after_seconds')::int between 1 and 86400, 'global retry_after is time to UTC midnight');
  -- retry_after is the time to the next UTC midnight (the assertion runs a moment later, so allow 1s of drift)
  perform tests.assert_true(
    (r ->> 'retry_after_seconds')::int - ceil(extract(epoch from
      ((date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc') - clock_timestamp()))::int between 0 and 1,
    'global retry_after matches next UTC midnight');
  -- the other provider has its own budget
  perform tests.assert_eq((tests.reserve(uc, 'google_places', p_global => 5) ->> 'allowed')::boolean, true, 'global budget is per provider');
  -- a raised limit lets traffic through again
  perform tests.assert_eq((tests.reserve(uc, p_global => 6) ->> 'allowed')::boolean, true, 'global limit is evaluated per call');
  -- failed and expired rows count against the budget too (the provider may have been billed)
  update public.provider_usage set status = 'failed', failure_reason = 'x' where provider = 'gemini_plan';
  perform tests.assert_eq(tests.reserve(uc, p_global => 6) ->> 'reason', 'global_budget', 'failed rows still count globally');
  -- rows from before UTC midnight do not count
  update public.provider_usage set created_at = (date_trunc('day', now() at time zone 'utc') at time zone 'utc') - interval '1 second'
  where provider = 'gemini_plan';
  perform tests.assert_eq((tests.reserve(uc, p_global => 5, p_inflight => 100) ->> 'allowed')::boolean, true, 'yesterday does not count toward the global budget');
end $$;

-- Stale reservations expire --------------------------------------------------------
do $$
declare r1 jsonb; r2 jsonb; u uuid := 'aaaaaaaa-0000-4000-8000-00000000000a';
begin
  delete from public.provider_usage;
  r1 := tests.reserve(u, p_inflight => 1, p_stale => 60);
  update public.provider_usage set created_at = created_at - interval '61 seconds';
  r2 := tests.reserve(u, p_inflight => 1, p_stale => 60);
  perform tests.assert_eq((r2 ->> 'allowed')::boolean, true, 'abandoned reservation no longer blocks');
  perform tests.assert_eq((select status || '/' || failure_reason from public.provider_usage where id = (r1 ->> 'reservation_id')::uuid), 'failed/expired', 'stale row marked failed/expired');
  perform tests.assert_true((select finished_at is not null from public.provider_usage where id = (r1 ->> 'reservation_id')::uuid), 'expired row has finished_at');
  -- A late success report from the crashed caller cannot resurrect the expired row
  perform tests.assert_eq(public.finish_provider_usage((r1 ->> 'reservation_id')::uuid, true, null), false, 'late finish of expired reservation is a no-op');
  perform tests.assert_eq((select status from public.provider_usage where id = (r1 ->> 'reservation_id')::uuid), 'failed', 'expired row stays failed');
  -- A fresh reservation is not expired
  perform tests.assert_eq((select status from public.provider_usage where id = (r2 ->> 'reservation_id')::uuid), 'reserved', 'fresh row stays reserved');
end $$;

-- finish_provider_usage ------------------------------------------------------------
do $$
declare r jsonb; rid uuid; u uuid := 'bbbbbbbb-0000-4000-8000-00000000000b';
begin
  delete from public.provider_usage;
  r := tests.reserve(u, p_action => 'abcdefghijklmnopqrstuvwxyz');
  rid := (r ->> 'reservation_id')::uuid;
  perform tests.assert_eq((select action from public.provider_usage where id = rid), 'abcdefghijklmnopqrst', 'action truncated to 20 chars');
  perform tests.assert_eq(public.finish_provider_usage(rid, false, repeat('x', 200)), true, 'finish failed');
  perform tests.assert_eq((select char_length(failure_reason) from public.provider_usage where id = rid), 60, 'failure_reason truncated to 60');
  perform tests.assert_eq(public.finish_provider_usage(rid, true, null), false, 'settled reservation cannot be settled again');
  perform tests.assert_eq((select status from public.provider_usage where id = rid), 'failed', 'first settlement wins');
  perform tests.assert_eq(public.finish_provider_usage(gen_random_uuid(), true, null), false, 'unknown reservation returns false');
  r := tests.reserve(u);
  rid := (r ->> 'reservation_id')::uuid;
  perform public.finish_provider_usage(rid, false, null);
  perform tests.assert_eq((select failure_reason from public.provider_usage where id = rid), 'provider_error', 'default failure reason');
  r := tests.reserve(u);
  rid := (r ->> 'reservation_id')::uuid;
  perform public.finish_provider_usage(rid, true, 'ignored');
  perform tests.assert_eq((select status || '/' || coalesce(failure_reason, '<null>') from public.provider_usage where id = rid), 'succeeded/<null>', 'success clears failure reason');
  perform tests.assert_true((select finished_at is not null from public.provider_usage where id = rid), 'finished_at set');
end $$;

-- The reservation row's created_at is the decision time, not the transaction start
do $$
declare r jsonb; first_ts timestamptz; second_ts timestamptz; u uuid := 'cccccccc-0000-4000-8000-00000000000c';
begin
  delete from public.provider_usage;
  r := tests.reserve(u);
  perform pg_sleep(0.05);
  r := tests.reserve(u);
  select min(created_at), max(created_at) into first_ts, second_ts from public.provider_usage where user_id = u;
  perform tests.assert_true(second_ts > first_ts, 'created_at uses clock_timestamp(), so same-transaction calls are ordered');
end $$;

rollback;
\echo test_provider_usage: ok
