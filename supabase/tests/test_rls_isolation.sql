-- Row level security and grant tests: two-user data isolation, anonymous access,
-- and structural audits (every table has RLS, no overly broad policies/grants).
--
-- Roamly stores days, stops, expenses and journals inside public.trips.plan
-- (jsonb), so isolating public.trips isolates all of them. The "social rows"
-- are public.profiles and public.connections.
--
-- Any failed assertion raises, which makes psql (ON_ERROR_STOP) exit non-zero.
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset
select tests.make_user('bbbbbbbb-0000-4000-8000-00000000000b', 'b@example.test') as b \gset
select tests.make_user('cccccccc-0000-4000-8000-00000000000c', 'c@example.test') as c \gset

-- Seed as the superuser: one trip per user with a recognisable plan.
insert into public.trips (id, owner_id, title, destination, start_date, end_date, updated_at, plan) values
  ('a1a1a1a1-0000-4000-8000-000000000001', :'a', 'A trip', 'Paris', '2026-12-01', '2026-12-03', '2020-01-01',
   '{"source":"manual","days":[{"id":"d-a","stops":[{"title":"A secret cafe"}]}],"expenses":[{"amount":10}],"journals":[{"text":"A diary"}]}'),
  ('b1b1b1b1-0000-4000-8000-000000000001', :'b', 'B trip', 'Rome', '2026-12-01', '2026-12-03', '2020-01-01',
   '{"source":"manual","days":[{"id":"d-b","stops":[{"title":"B secret cafe"}]}],"expenses":[{"amount":20}],"journals":[{"text":"B diary"}]}');

insert into public.profiles (user_id, handle, display_name, discoverable) values
  (:'a', 'alice', 'Alice', true),
  (:'b', 'bobby', 'Bob', true),
  (:'c', 'carol', 'Carol', false);

-- B and C are connected; A is not part of that connection.
insert into public.connections (id, requester_id, addressee_id, status) values
  ('c0c0c0c0-0000-4000-8000-000000000001', :'b', :'c', 'accepted');

insert into public.locals_waitlist (id, user_id, email, city) values
  ('d0d0d0d0-0000-4000-8000-00000000000a', :'a', 'a-wait@example.test', 'Lyon'),
  ('d0d0d0d0-0000-4000-8000-00000000000b', :'b', 'b-wait@example.test', 'Lyon'),
  ('d0d0d0d0-0000-4000-8000-0000000000ff', null, 'anon-wait@example.test', 'Lyon');

insert into public.ai_plan_requests (user_id, request_bucket) values (:'a', 1), (:'b', 2);
insert into public.place_search_requests (user_id, action) values (:'a', 'details'), (:'b', 'details');
insert into public.provider_usage (user_id, provider, status) values
  (:'a', 'gemini_plan', 'succeeded'), (:'b', 'google_places', 'succeeded');

-- trips ----------------------------------------------------------------------
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.trips$$, 1, 'A sees only own trips');
select tests.assert_rows($$select 1 from public.trips where owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'A cannot select B trips by owner');
select tests.assert_rows($$select 1 from public.trips where id = 'b1b1b1b1-0000-4000-8000-000000000001'$$, 0, 'A cannot select B trip by id');
select tests.assert_rows($$select 1 from public.trips where plan::text like '%B secret%'$$, 0, 'A cannot read B plan (days/stops/expenses/journals)');
select tests.assert_rows($$select 1 from public.trips where plan::text like '%A secret%' and plan -> 'journals' is not null$$, 1, 'A reads own plan');
select tests.assert_affects($$update public.trips set title = 'hacked' where id = 'b1b1b1b1-0000-4000-8000-000000000001'$$, 0, 'A cannot update B trip');
select tests.assert_affects($$delete from public.trips where id = 'b1b1b1b1-0000-4000-8000-000000000001'$$, 0, 'A cannot delete B trip');
select tests.assert_affects($$update public.trips set plan = jsonb_set(plan, '{journals}', '[]') where owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'A cannot wipe B journals');
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'x', 'x', '2026-01-01', '2026-01-02')$$, 'A cannot create a trip owned by B');
select tests.assert_denied($$update public.trips set owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b' where id = 'a1a1a1a1-0000-4000-8000-000000000001'$$, 'A cannot hand own trip to B');
select tests.assert_affects($$insert into public.trips (owner_id, title, destination, start_date, end_date) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'A second', 'Nice', '2026-01-01', '2026-01-02')$$, 1, 'A can create own trip');
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date, plan) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'bad', 'x', '2026-01-01', '2026-01-02', '{"days":{}}')$$, 'plan shape constraint', '23514');
-- The updated_at trigger lives in the unexposed private schema but must still fire for API roles.
select tests.assert_affects($$update public.trips set title = 'A renamed' where id = 'a1a1a1a1-0000-4000-8000-000000000001'$$, 1, 'A can update own trip');
select tests.assert_rows($$select 1 from public.trips where id = 'a1a1a1a1-0000-4000-8000-000000000001' and updated_at > '2020-01-02'$$, 1, 'updated_at trigger fires for authenticated');
select tests.assert_denied($$select private.set_updated_at()$$, 'private function not callable by authenticated');

select tests.as_user(:'b');
select tests.assert_rows($$select 1 from public.trips$$, 1, 'B sees only own trips');
select tests.assert_rows($$select 1 from public.trips where owner_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0, 'B cannot select A trips');

select tests.as_anon();
select tests.assert_denied($$select 1 from public.trips$$, 'anon cannot select trips');
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'x', 'x', '2026-01-01', '2026-01-02')$$, 'anon cannot insert trips');
select tests.assert_denied($$update public.trips set title = 'x'$$, 'anon cannot update trips');
select tests.assert_denied($$delete from public.trips$$, 'anon cannot delete trips');

select tests.as_admin();
select tests.assert_rows($$select 1 from public.trips where id = 'b1b1b1b1-0000-4000-8000-000000000001' and title = 'B trip' and plan::text like '%B diary%'$$, 1, 'B trip untouched after attacks');
select tests.assert_rows($$select 1 from public.trips where owner_id = (select id from auth.users where email = 'a@example.test')$$, 2, 'A has exactly two trips');

-- profiles -------------------------------------------------------------------
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.profiles where handle = 'bobby'$$, 1, 'A discovers B (discoverable)');
select tests.assert_rows($$select 1 from public.profiles where handle = 'carol'$$, 0, 'A cannot see non-discoverable C');
select tests.assert_affects($$update public.profiles set display_name = 'pwned' where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'A cannot update B profile');
select tests.assert_denied($$delete from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 'authenticated has no delete on profiles');
select tests.assert_denied($$insert into public.profiles (user_id, handle, display_name) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'bob2', 'Bob 2')$$, 'A cannot create profile for B');
select tests.assert_denied($$update public.profiles set user_id = 'bbbbbbbb-0000-4000-8000-00000000000b' where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 'user_id is not updatable');
select tests.assert_denied($$update public.profiles set created_at = now() where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 'created_at is not updatable');
select tests.assert_affects($$update public.profiles set display_name = 'Alice 2' where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1, 'A updates own profile');
select tests.assert_denied($$update public.profiles set handle = 'Bad Handle!' where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 'handle format constraint', '23514');
select tests.assert_denied($$update public.profiles set avatar_url = 'http://insecure.example/x.png' where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 'avatar must be https', '23514');

select tests.as_user(:'b');
select tests.assert_rows($$select 1 from public.profiles where handle = 'carol'$$, 1, 'B sees connected non-discoverable C');
select tests.as_user(:'c');
select tests.assert_rows($$select 1 from public.profiles where handle = 'bobby'$$, 1, 'C sees connected B');
select tests.assert_rows($$select 1 from public.profiles where handle = 'alice'$$, 1, 'C (authenticated) discovers discoverable A');

select tests.as_anon();
select tests.assert_denied($$select 1 from public.profiles$$, 'anon cannot select profiles');
select tests.assert_denied($$insert into public.profiles (user_id, handle, display_name) values (gen_random_uuid(), 'anonhandle', 'x')$$, 'anon cannot insert profiles');

-- connections ----------------------------------------------------------------
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.connections$$, 0, 'A cannot see the B-C connection');
select tests.assert_affects($$update public.connections set status = 'declined'$$, 0, 'A cannot update the B-C connection');
select tests.assert_affects($$delete from public.connections$$, 0, 'A cannot delete the B-C connection');
select tests.assert_denied($$insert into public.connections (requester_id, addressee_id) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000a')$$, 'A cannot forge a request from B');
select tests.assert_denied($$insert into public.connections (requester_id, addressee_id, status) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b', 'accepted')$$, 'A cannot self-accept');
select tests.assert_denied($$insert into public.connections (requester_id, addressee_id) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-00000000000a')$$, 'no self connection');
select tests.assert_affects($$insert into public.connections (requester_id, addressee_id) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b')$$, 1, 'A requests B');
select tests.assert_denied($$insert into public.connections (requester_id, addressee_id) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b')$$, 'duplicate pair rejected', '23505');
select tests.assert_affects($$update public.connections set status = 'accepted' where requester_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0, 'requester cannot accept own request');
select tests.assert_rows($$select 1 from public.connections$$, 1, 'A sees own request only');

select tests.as_user(:'c');
select tests.assert_rows($$select 1 from public.connections where requester_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0, 'C cannot see A->B request');

select tests.as_user(:'b');
select tests.assert_rows($$select 1 from public.connections$$, 2, 'B sees both own connections');
select tests.assert_denied($$update public.connections set requester_id = 'cccccccc-0000-4000-8000-00000000000c' where requester_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 'participants are not updatable by column grant');
select tests.assert_affects($$update public.connections set status = 'accepted' where requester_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1, 'addressee accepts');
select tests.assert_affects($$update public.connections set status = 'pending' where requester_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 0, 'accepted request cannot be reopened');

select tests.as_anon();
select tests.assert_denied($$select 1 from public.connections$$, 'anon cannot select connections');
select tests.assert_denied($$insert into public.connections (requester_id, addressee_id) values (gen_random_uuid(), gen_random_uuid())$$, 'anon cannot insert connections');

-- locals_waitlist -----------------------------------------------------------
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.locals_waitlist$$, 1, 'A reads only own waitlist entry');
select tests.assert_rows($$select 1 from public.locals_waitlist where email = 'b-wait@example.test'$$, 0, 'A cannot read B waitlist entry');
select tests.assert_rows($$select 1 from public.locals_waitlist where user_id is null$$, 0, 'A cannot read anonymous waitlist entries');
select tests.assert_denied($$insert into public.locals_waitlist (user_id, email, city) values ('bbbbbbbb-0000-4000-8000-00000000000b', 'spoof@example.test', 'Nice')$$, 'A cannot join waitlist as B');
select tests.assert_denied($$insert into public.locals_waitlist (user_id, email, city) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'a2@example.test', 'Nice')$$, 'direct waitlist insert is revoked (use join_locals_waitlist)');
select tests.assert_denied($$update public.locals_waitlist set city = 'x'$$, 'authenticated cannot update waitlist');
select tests.assert_denied($$delete from public.locals_waitlist$$, 'authenticated cannot delete waitlist');

select tests.as_user(:'b');
select tests.assert_rows($$select 1 from public.locals_waitlist$$, 1, 'B reads only own waitlist entry');

select tests.as_anon();
select tests.assert_denied($$select 1 from public.locals_waitlist$$, 'anon cannot read waitlist');
select tests.assert_denied($$insert into public.locals_waitlist (email, city) values ('visitor@example.test', 'Nice')$$, 'anon direct waitlist insert is revoked (use join_locals_waitlist)');
select tests.assert_denied($$insert into public.locals_waitlist (user_id, email, city) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'spoof2@example.test', 'Nice')$$, 'anon cannot join as A');
select tests.assert_denied($$update public.locals_waitlist set city = 'x'$$, 'anon cannot update waitlist');
select tests.assert_denied($$delete from public.locals_waitlist$$, 'anon cannot delete waitlist');

-- legacy usage tables and the new ledger -----------------------------------
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.ai_plan_requests$$, 1, 'A sees only own legacy AI rows');
select tests.assert_denied($$insert into public.ai_plan_requests (user_id, request_bucket) values ('bbbbbbbb-0000-4000-8000-00000000000b', 99)$$, 'A cannot write legacy AI rows for B');
select tests.assert_denied($$update public.ai_plan_requests set request_bucket = 0$$, 'authenticated cannot update legacy AI rows');
select tests.assert_denied($$delete from public.ai_plan_requests$$, 'authenticated cannot delete legacy AI rows');
select tests.assert_denied($$select 1 from public.place_search_requests$$, 'authenticated cannot read place ledger');
select tests.assert_denied($$insert into public.place_search_requests (user_id, action) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'details')$$, 'authenticated cannot write place ledger');
select tests.assert_denied($$select 1 from public.provider_usage$$, 'authenticated cannot read provider_usage');
select tests.assert_denied($$insert into public.provider_usage (user_id, provider) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'gemini_plan')$$, 'authenticated cannot write provider_usage');
select tests.assert_denied($$update public.provider_usage set status = 'failed'$$, 'authenticated cannot update provider_usage');
select tests.assert_denied($$delete from public.provider_usage$$, 'authenticated cannot delete provider_usage');

select tests.as_anon();
select tests.assert_denied($$select 1 from public.ai_plan_requests$$, 'anon cannot read legacy AI rows');
select tests.assert_denied($$insert into public.ai_plan_requests (user_id, request_bucket) values (gen_random_uuid(), 1)$$, 'anon cannot write legacy AI rows');
select tests.assert_denied($$select 1 from public.place_search_requests$$, 'anon cannot read place ledger');
select tests.assert_denied($$select 1 from public.provider_usage$$, 'anon cannot read provider_usage');
select tests.assert_denied($$delete from public.provider_usage$$, 'anon cannot delete provider_usage');

select tests.as_service();
select tests.assert_rows($$select 1 from public.provider_usage$$, 2, 'service_role reads provider_usage (BYPASSRLS)');
select tests.assert_rows($$select 1 from public.place_search_requests$$, 2, 'service_role reads place ledger');

-- auth.users is not reachable from the API roles ------------------------------
select tests.as_user(:'a');
select tests.assert_denied($$select 1 from auth.users$$, 'authenticated cannot read auth.users');
select tests.as_anon();
select tests.assert_denied($$select 1 from auth.users$$, 'anon cannot read auth.users');

-- Deleting an auth user removes their private data, including linked waitlist rows ---
select tests.as_admin();
delete from auth.users where id = :'b';
select tests.assert_rows($$select 1 from public.trips where owner_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'trips cascade on user delete');
select tests.assert_rows($$select 1 from public.profiles where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'profile cascades on user delete');
select tests.assert_rows($$select 1 from public.connections where requester_id = 'bbbbbbbb-0000-4000-8000-00000000000b' or addressee_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'connections cascade on user delete');
select tests.assert_rows($$select 1 from public.provider_usage where user_id = 'bbbbbbbb-0000-4000-8000-00000000000b'$$, 0, 'provider_usage cascades on user delete');
select tests.assert_rows($$select 1 from public.locals_waitlist where email = 'b-wait@example.test'$$, 0, 'waitlist row cascades on user delete');

-- Structural audits ----------------------------------------------------------
-- 1. Every table in a schema that PostgREST could expose, or that the API roles
--    can use, has RLS enabled. (private and auth are not exposed; they are
--    covered by the schema-usage and grant checks below.)
do $$
declare r record;
begin
  for r in
    select n.nspname, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname = 'public' and not c.relrowsecurity
  loop
    raise exception 'FAIL [RLS audit]: %.% is in an exposed schema with RLS disabled', r.nspname, r.relname;
  end loop;
end $$;

-- 2. Nothing in public or private is writable by anon, and anon only gets the
--    privilege at all on any table (the waitlist is joined through a function).
do $$
declare r record;
begin
  for r in
    select table_schema, table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema in ('public', 'private', 'auth')
  loop
    raise exception 'FAIL [grant audit]: anon has % on %.%', r.privilege_type, r.table_schema, r.table_name;
  end loop;
end $$;

-- 3. authenticated: no DDL-ish privileges anywhere, and no grants at all on the
--    server-only tables.
do $$
declare r record;
begin
  for r in
    select table_schema, table_name, privilege_type
    from information_schema.role_table_grants
    where grantee in ('authenticated', 'anon', 'PUBLIC')
      and table_schema in ('public', 'private', 'auth')
      and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  loop
    raise exception 'FAIL [grant audit]: % has % on %.%', 'API role', r.privilege_type, r.table_schema, r.table_name;
  end loop;
  for r in
    select table_name, privilege_type from information_schema.role_table_grants
    where grantee in ('authenticated', 'anon', 'PUBLIC')
      and table_schema = 'public' and table_name in ('provider_usage', 'place_search_requests')
  loop
    raise exception 'FAIL [grant audit]: API role has % on server-only table %', r.privilege_type, r.table_name;
  end loop;
end $$;

-- 4. Policy audit: every policy on a table with client grants must reference the
--    caller (auth.uid()) or be an explicit deny. A bare "true" is flagged. The
--    only allowed exception is nothing; add to the list below with a comment if
--    a table ever needs to be public.
do $$
declare r record;
begin
  for r in
    select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public'
  loop
    if coalesce(r.qual, '') in ('true', '(true)') or coalesce(r.with_check, '') in ('true', '(true)') then
      raise exception 'FAIL [policy audit]: %.% has an always-true predicate', r.tablename, r.policyname;
    end if;
    if r.cmd in ('UPDATE', 'DELETE', 'ALL') and r.qual is null then
      raise exception 'FAIL [policy audit]: %.% (%) has no USING clause', r.tablename, r.policyname, r.cmd;
    end if;
    if r.cmd in ('INSERT', 'ALL') and r.with_check is null then
      raise exception 'FAIL [policy audit]: %.% (%) has no WITH CHECK clause', r.tablename, r.policyname, r.cmd;
    end if;
    if r.cmd = 'SELECT' and r.qual not like '%auth.uid()%' then
      raise exception 'FAIL [policy audit]: SELECT policy %.% does not depend on auth.uid(): %', r.tablename, r.policyname, r.qual;
    end if;
  end loop;
end $$;

-- 5. Schema private is not usable by the API roles; functions in public/private
--    are not executable by them, except the explicitly allowed RPCs below.
select tests.assert_true(not has_schema_privilege('anon', 'private', 'USAGE')
  and not has_schema_privilege('authenticated', 'private', 'USAGE'), 'private schema is closed to API roles');
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, a.grantee
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname in ('public', 'private') and a.privilege_type = 'EXECUTE'
      and p.oid::regprocedure::text <> 'join_locals_waitlist(text,text,text)'
      and (a.grantee = 0 or a.grantee in (select oid from pg_roles where rolname in ('anon', 'authenticated')))
  loop
    raise exception 'FAIL [function audit]: % is executable by %', r.sig, case when r.grantee = 0 then 'PUBLIC' else r.grantee::regrole::text end;
  end loop;
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    raise exception 'FAIL [function audit]: SECURITY DEFINER function % has no fixed search_path', r.sig;
  end loop;
end $$;

rollback;
\echo test_rls_isolation: ok
