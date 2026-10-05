-- Account deletion: nothing personal may survive deleting an auth user, and the
-- cleanup function must only be callable by the service role.
-- Mirrors what the delete-account Edge Function does: delete_account_data(), then
-- delete from auth.users (what auth.admin.deleteUser does).
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('dddddddd-0000-4000-8000-00000000000a', 'Leaving.User@Example.test') as a \gset
select tests.make_user('dddddddd-0000-4000-8000-00000000000b', 'staying@example.test') as b \gset

-- Fixtures ------------------------------------------------------------------------------
insert into public.trips (owner_id, title, destination, start_date, end_date) values
  (:'a', 'A trip', 'Paris', '2026-10-01', '2026-10-03'),
  (:'b', 'B trip', 'Rome', '2026-10-01', '2026-10-03');
insert into public.profiles (user_id, handle, display_name) values
  (:'a', 'leaving', 'Leaving'), (:'b', 'staying', 'Staying');
insert into public.connections (requester_id, addressee_id, status) values (:'a', :'b', 'accepted');
insert into public.provider_usage (user_id, provider, action, status) values
  (:'a', 'gemini_plan', 'plan', 'succeeded'), (:'b', 'gemini_plan', 'plan', 'succeeded');
insert into public.ai_plan_requests (user_id, request_bucket) values (:'a', 1), (:'b', 1);
insert into public.place_search_requests (user_id, action) values (:'a', 'nearby'), (:'b', 'nearby');

insert into public.locals_waitlist (user_id, email, city) values
  (:'a', 'linked-other-address@example.test', 'Paris'),  -- linked to the account, different address
  (null, 'leaving.user@example.test', 'Lisbon'),          -- joined signed out, same address, other case
  (null, '  LEAVING.USER@EXAMPLE.TEST ', 'Rome'),         -- same address with whitespace and upper case
  (:'b', 'staying@example.test', 'Paris'),                -- someone else's, must survive
  (null, 'stranger@example.test', 'Paris');               -- unrelated visitor, must survive

-- Privileges ----------------------------------------------------------------------------
select tests.assert_true(has_function_privilege('service_role', 'public.delete_account_data(uuid)', 'EXECUTE'), 'service_role can run the cleanup');
select tests.assert_true(not has_function_privilege('anon', 'public.delete_account_data(uuid)', 'EXECUTE'), 'anon cannot run the cleanup');
select tests.assert_true(not has_function_privilege('authenticated', 'public.delete_account_data(uuid)', 'EXECUTE'), 'authenticated cannot run the cleanup');
select tests.assert_true(
  not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where p.proname = 'delete_account_data' and x.grantee = 0),
  'EXECUTE is not granted to PUBLIC');
select tests.assert_true(
  (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
   from pg_proc p where p.proname = 'delete_account_data' and p.pronamespace = 'public'::regnamespace),
  'cleanup is SECURITY DEFINER with search_path = ''''');

select tests.as_user(:'a');
select tests.assert_denied(format('select public.delete_account_data(%L)', :'b'), 'a signed-in user cannot clean up another account');
select tests.assert_denied(format('select public.delete_account_data(%L)', :'a'), 'a signed-in user cannot call the cleanup directly');
select tests.as_anon();
select tests.assert_denied(format('select public.delete_account_data(%L)', :'a'), 'anon cannot call the cleanup');
select tests.as_admin();

-- Foreign key ---------------------------------------------------------------------------
select tests.assert_eq(
  (select c.confdeltype::text from pg_constraint c
   where c.conrelid = 'public.locals_waitlist'::regclass and c.contype = 'f' and c.confrelid = 'auth.users'::regclass),
  'c', 'locals_waitlist.user_id cascades when the user is deleted');

-- Cleanup + delete ----------------------------------------------------------------------
select tests.as_service();
select tests.assert_eq(public.delete_account_data(:'a') ->> 'waitlist_deleted', '3', 'cleanup reports the waitlist rows it removed');
select tests.assert_eq(public.delete_account_data(:'a') ->> 'waitlist_deleted', '0', 'cleanup is idempotent');
select tests.assert_denied('select public.delete_account_data(null)', 'cleanup requires a user id', 'P0001');
select tests.as_admin();

select tests.assert_rows(format('select 1 from public.locals_waitlist where lower(btrim(email)) = %L or user_id = %L', 'leaving.user@example.test', :'a'), 0, 'no waitlist row of the account survives');
select tests.assert_rows('select 1 from public.locals_waitlist', 2, 'other visitors keep their waitlist rows');

delete from auth.users where id = :'a';

select tests.assert_rows(format('select 1 from public.trips where owner_id = %L', :'a'), 0, 'trips are gone');
select tests.assert_rows(format('select 1 from public.profiles where user_id = %L', :'a'), 0, 'profile is gone');
select tests.assert_rows('select 1 from public.connections', 0, 'connections of the account are gone');
select tests.assert_rows(format('select 1 from public.provider_usage where user_id = %L', :'a'), 0, 'provider usage is gone');
select tests.assert_rows(format('select 1 from public.ai_plan_requests where user_id = %L', :'a'), 0, 'legacy AI usage is gone');
select tests.assert_rows(format('select 1 from public.place_search_requests where user_id = %L', :'a'), 0, 'legacy Places usage is gone');
select tests.assert_rows(format('select 1 from public.trips where owner_id = %L', :'b'), 1, 'other users keep their trips');
select tests.assert_rows(format('select 1 from public.profiles where user_id = %L', :'b'), 1, 'other users keep their profile');
select tests.assert_rows(format('select 1 from public.provider_usage where user_id = %L', :'b'), 1, 'other users keep their usage');

-- The FK alone (cleanup skipped) removes rows linked to the user -------------------------
select tests.make_user('dddddddd-0000-4000-8000-00000000000c', 'skipped@example.test') as c \gset
insert into public.locals_waitlist (user_id, email, city) values (:'c', 'skipped-linked@example.test', 'Berlin');
delete from auth.users where id = :'c';
select tests.assert_rows(format('select 1 from public.locals_waitlist where user_id = %L or email = %L', :'c', 'skipped-linked@example.test'), 0, 'linked waitlist rows cascade even without the cleanup');

-- Cleanup for an unknown user id is harmless ----------------------------------------------
select tests.as_service();
select tests.assert_eq(public.delete_account_data('dddddddd-0000-4000-8000-0000000000ff') ->> 'waitlist_deleted', '0', 'unknown user id deletes nothing');
select tests.as_admin();
select tests.assert_rows('select 1 from public.locals_waitlist', 2, 'unrelated rows untouched after the unknown-user call');

rollback;
