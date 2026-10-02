-- Only the service role may reserve/settle quota or touch the usage tables.
-- Covers GRANTs, SECURITY DEFINER hygiene and the RLS deny policies, from the
-- point of view of the roles PostgREST switches into.
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset

-- A real, live reservation owned by A, so that finish_provider_usage has something to attack.
select tests.as_service();
select (public.reserve_provider_usage(:'a', 'gemini_plan', 'plan', 5, 5, 0, 5, 100, 180) ->> 'reservation_id') as rid \gset
select tests.as_admin();

-- Function privileges ------------------------------------------------------------------
select tests.assert_true(has_function_privilege('service_role', 'public.reserve_provider_usage(uuid,text,text,int,int,int,int,int,int)', 'EXECUTE'), 'service_role can reserve');
select tests.assert_true(has_function_privilege('service_role', 'public.finish_provider_usage(uuid,boolean,text)', 'EXECUTE'), 'service_role can finish');
select tests.assert_true(not has_function_privilege('anon', 'public.reserve_provider_usage(uuid,text,text,int,int,int,int,int,int)', 'EXECUTE'), 'anon cannot execute reserve (ACL)');
select tests.assert_true(not has_function_privilege('authenticated', 'public.reserve_provider_usage(uuid,text,text,int,int,int,int,int,int)', 'EXECUTE'), 'authenticated cannot execute reserve (ACL)');
select tests.assert_true(not has_function_privilege('anon', 'public.finish_provider_usage(uuid,boolean,text)', 'EXECUTE'), 'anon cannot execute finish (ACL)');
select tests.assert_true(not has_function_privilege('authenticated', 'public.finish_provider_usage(uuid,boolean,text)', 'EXECUTE'), 'authenticated cannot execute finish (ACL)');
-- PUBLIC pseudo-role: a role created later must not inherit execute either
select tests.assert_true(
  not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.proname in ('reserve_provider_usage', 'finish_provider_usage') and a.grantee = 0),
  'EXECUTE is not granted to PUBLIC');

-- SECURITY DEFINER functions must pin search_path (otherwise a caller-controlled
-- schema could shadow functions/operators they use and run code as the owner).
select tests.assert_true(
  (select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path=')))
   from pg_proc p where p.proname in ('reserve_provider_usage', 'finish_provider_usage') and p.pronamespace = 'public'::regnamespace),
  'quota functions are SECURITY DEFINER with search_path = ''''');
select tests.assert_true(
  (select pg_get_userbyid(proowner) = current_user from pg_proc where proname = 'reserve_provider_usage'),
  'quota functions owned by the migration role');

-- Calling the functions as a client role ----------------------------------------------
select tests.as_anon();
select tests.assert_denied($$select public.reserve_provider_usage('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan', 'plan', 100, 100, 0, 100, 100000, 180)$$, 'anon cannot call reserve');
select tests.assert_denied($$select public.finish_provider_usage(gen_random_uuid(), true, null)$$, 'anon cannot call finish');

select tests.as_user(:'a');
select tests.assert_denied($$select public.reserve_provider_usage('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan', 'plan', 100, 100, 0, 100, 100000, 180)$$, 'authenticated cannot call reserve for self');
select tests.assert_denied($$select public.reserve_provider_usage('bbbbbbbb-0000-4000-8000-00000000000b', 'gemini_plan', 'plan', 100, 100, 0, 100, 100000, 180)$$, 'authenticated cannot call reserve for others');
select tests.assert_denied(format($f$select public.finish_provider_usage(%L, true, null)$f$, :'rid'), 'authenticated cannot settle a reservation as succeeded');
select tests.assert_denied(format($f$select public.finish_provider_usage(%L, false, 'x')$f$, :'rid'), 'authenticated cannot settle a reservation as failed');

-- Direct table access ---------------------------------------------------------------------
select tests.assert_denied($$select * from public.provider_usage$$, 'authenticated cannot read the ledger');
select tests.assert_denied($$insert into public.provider_usage (user_id, provider, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan', 'succeeded')$$, 'authenticated cannot forge a ledger row');
select tests.assert_denied($$update public.provider_usage set status = 'failed', failure_reason = 'refund'$$, 'authenticated cannot refund quota');
select tests.assert_denied($$delete from public.provider_usage$$, 'authenticated cannot erase usage');
select tests.assert_denied($$truncate public.provider_usage$$, 'authenticated cannot truncate usage');
select tests.assert_denied($$select * from public.place_search_requests$$, 'authenticated cannot read the legacy place ledger');
select tests.assert_denied($$delete from public.place_search_requests$$, 'authenticated cannot erase the legacy place ledger');

select tests.as_anon();
select tests.assert_denied($$select * from public.provider_usage$$, 'anon cannot read the ledger');
select tests.assert_denied($$insert into public.provider_usage (user_id, provider) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan')$$, 'anon cannot write the ledger');
select tests.assert_denied($$update public.provider_usage set status = 'failed'$$, 'anon cannot update the ledger');
select tests.assert_denied($$delete from public.provider_usage$$, 'anon cannot delete from the ledger');

-- The deny policy is a second line of defence: even if a table grant slipped in
-- (e.g. a Supabase dashboard "grant all"), RLS still hides every row.
select tests.as_admin();
grant select, insert, update, delete on public.provider_usage to authenticated, anon;
grant select, insert, update, delete on public.place_search_requests to authenticated, anon;
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.provider_usage$$, 0, 'deny policy hides ledger rows even with a select grant');
select tests.assert_denied($$insert into public.provider_usage (user_id, provider, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan', 'succeeded')$$, 'deny policy blocks inserts even with an insert grant');
select tests.assert_affects($$update public.provider_usage set status = 'failed'$$, 0, 'deny policy blocks updates even with an update grant');
select tests.assert_affects($$delete from public.provider_usage$$, 0, 'deny policy blocks deletes even with a delete grant');
select tests.assert_rows($$select 1 from public.place_search_requests$$, 0, 'deny policy hides legacy place ledger even with a select grant');
select tests.as_anon();
select tests.assert_rows($$select 1 from public.provider_usage$$, 0, 'deny policy hides ledger rows from anon even with a select grant');
select tests.as_admin();
select tests.assert_eq((select status from public.provider_usage where id = :'rid'::uuid), 'reserved', 'attacks left the reservation untouched');

-- Service role path still works end to end -------------------------------------------------
select tests.as_service();
select tests.assert_eq(public.finish_provider_usage(:'rid'::uuid, true, null), true, 'service_role can settle');
select tests.assert_rows($$select 1 from public.provider_usage where status = 'succeeded'$$, 1, 'service_role sees the ledger');

rollback;
\echo test_provider_usage_privileges: ok
