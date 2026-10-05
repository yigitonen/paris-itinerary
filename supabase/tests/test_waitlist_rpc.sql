-- Locals waitlist: joining through public.join_locals_waitlist() must not reveal whether
-- an (email, city) entry already exists, and direct table access stays closed.
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset
select tests.make_user('bbbbbbbb-0000-4000-8000-00000000000b', 'b@example.test') as b \gset

-- Privileges ------------------------------------------------------------------------------
select tests.assert_true(has_function_privilege('anon', 'public.join_locals_waitlist(text,text,text)', 'EXECUTE'), 'anon can execute join_locals_waitlist');
select tests.assert_true(has_function_privilege('authenticated', 'public.join_locals_waitlist(text,text,text)', 'EXECUTE'), 'authenticated can execute join_locals_waitlist');
select tests.assert_true(
  not exists (
    select 1 from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.proname = 'join_locals_waitlist' and a.grantee = 0),
  'EXECUTE on join_locals_waitlist is not granted to PUBLIC');
select tests.assert_true(
  (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
   from pg_proc p where p.proname = 'join_locals_waitlist' and p.pronamespace = 'public'::regnamespace),
  'join_locals_waitlist is SECURITY DEFINER with search_path = ''''');
select tests.assert_true(
  not exists (select 1 from information_schema.role_table_grants
              where grantee in ('anon', 'authenticated', 'PUBLIC') and table_schema = 'public'
                and table_name = 'locals_waitlist' and privilege_type = 'INSERT'),
  'no INSERT grant on locals_waitlist for API roles');
select tests.assert_true(
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'locals_waitlist' and cmd in ('INSERT', 'ALL')),
  'no INSERT policy on locals_waitlist');

-- Anonymous visitors ------------------------------------------------------------------------
select tests.as_anon();
select public.join_locals_waitlist('Visitor@Example.test', 'Nice', 'hello') as first_join \gset
select public.join_locals_waitlist('Visitor@Example.test', 'Nice', 'hello') as same_again \gset
select public.join_locals_waitlist('visitor@example.test', 'NICE', '') as other_case \gset
select public.join_locals_waitlist('fresh@example.test', 'Nice', '') as fresh_join \gset
select tests.assert_eq(:'same_again'::jsonb, :'first_join'::jsonb, 'anon duplicate join returns the same result as the first');
select tests.assert_eq(:'other_case'::jsonb, :'first_join'::jsonb, 'duplicate differing only in case returns the same result');
select tests.assert_eq(:'fresh_join'::jsonb, :'first_join'::jsonb, 'a new e-mail returns the same result as a duplicate');
select tests.assert_eq(:'first_join'::jsonb, '{"ok": true}'::jsonb, 'join result');

select tests.as_admin();
select tests.assert_rows($$select 1 from public.locals_waitlist where lower(email) = 'visitor@example.test'$$, 1, 'duplicates stored once (first spelling wins)');
select tests.assert_rows($$select 1 from public.locals_waitlist where email = 'Visitor@Example.test' and note = 'hello' and user_id is null$$, 1, 'anon row has no user_id and keeps the first submission');
select tests.assert_rows($$select 1 from public.locals_waitlist$$, 2, 'two distinct entries');

-- The same email in another city is a different entry.
select tests.as_anon();
select public.join_locals_waitlist('visitor@example.test', 'Lyon', '');
select tests.as_admin();
select tests.assert_rows($$select 1 from public.locals_waitlist where lower(email) = 'visitor@example.test'$$, 2, 'same e-mail, other city is a separate entry');

-- Whitespace is trimmed so padding cannot dodge the unique index.
select tests.as_anon();
select public.join_locals_waitlist('  visitor@example.test ', ' Nice ', '');
select tests.as_admin();
select tests.assert_rows($$select 1 from public.locals_waitlist where lower(email) = 'visitor@example.test'$$, 2, 'padded duplicate is ignored');

-- Direct access is closed ---------------------------------------------------------------------
select tests.as_anon();
select tests.assert_denied($$insert into public.locals_waitlist (email, city) values ('direct@example.test', 'Nice')$$, 'anon cannot insert directly');
select tests.assert_denied($$insert into public.locals_waitlist (email, city) values ('visitor@example.test', 'Nice')$$, 'anon cannot probe via a direct duplicate insert (42501, not 23505)');
select tests.assert_denied($$select 1 from public.locals_waitlist$$, 'anon cannot select waitlist rows');
select tests.assert_denied($$update public.locals_waitlist set city = 'x'$$, 'anon cannot update the waitlist');
select tests.assert_denied($$delete from public.locals_waitlist$$, 'anon cannot delete from the waitlist');

-- Signed-in users ---------------------------------------------------------------------------------
select tests.as_user(:'a');
select public.join_locals_waitlist('a-wait@example.test', 'Paris', 'note') as a_first \gset
select public.join_locals_waitlist('a-wait@example.test', 'Paris', 'note') as a_again \gset
select tests.assert_eq(:'a_again'::jsonb, :'a_first'::jsonb, 'authenticated duplicate join returns the same result');
select tests.assert_eq(:'a_first'::jsonb, :'first_join'::jsonb, 'authenticated and anon get the same shape');
select tests.assert_rows($$select 1 from public.locals_waitlist$$, 1, 'A reads only their own entry');
select tests.assert_rows($$select 1 from public.locals_waitlist where user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1, 'user_id is the caller');
select tests.assert_denied($$insert into public.locals_waitlist (user_id, email, city) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'direct@example.test', 'Nice')$$, 'authenticated cannot insert directly');
select tests.assert_denied($$update public.locals_waitlist set city = 'x'$$, 'authenticated cannot update the waitlist');
select tests.assert_denied($$delete from public.locals_waitlist$$, 'authenticated cannot delete from the waitlist');

-- B joining an e-mail that A (or an anonymous visitor) already used gets the same answer and sees nothing of it.
select tests.as_user(:'b');
select public.join_locals_waitlist('a-wait@example.test', 'Paris', 'note') as b_dup \gset
select tests.assert_eq(:'b_dup'::jsonb, :'first_join'::jsonb, 'joining someone else''s e-mail looks like any other join');
select tests.assert_rows($$select 1 from public.locals_waitlist$$, 0, 'B still sees no rows (the duplicate was ignored, not attributed to B)');
select tests.as_admin();
select tests.assert_rows($$select 1 from public.locals_waitlist where lower(email) = 'a-wait@example.test' and user_id = 'aaaaaaaa-0000-4000-8000-00000000000a'$$, 1, 'the original owner keeps the row');

-- Validation (depends only on the caller's own input) ----------------------------------------------
select tests.as_anon();
select tests.assert_denied($$select public.join_locals_waitlist('a@b', 'Nice', '')$$, 'email too short', '22023');
select tests.assert_denied($$select public.join_locals_waitlist(null, 'Nice', '')$$, 'null email', '22023');
select tests.assert_denied($$select public.join_locals_waitlist(repeat('a', 250) || '@b.co', 'Nice', '')$$, 'email too long', '22023');
select tests.assert_denied($$select public.join_locals_waitlist('ok@example.test', '', '')$$, 'empty city', '22023');
select tests.assert_denied($$select public.join_locals_waitlist('ok@example.test', '   ', '')$$, 'blank city', '22023');
select tests.assert_denied($$select public.join_locals_waitlist('ok@example.test', repeat('c', 101), '')$$, 'city too long', '22023');
select tests.assert_denied($$select public.join_locals_waitlist('ok@example.test', 'Nice', repeat('n', 501))$$, 'note too long', '22023');
select public.join_locals_waitlist('limits@example.test', repeat('c', 100), repeat('n', 500));
select public.join_locals_waitlist('nullnote@example.test', 'Nice', null);
select tests.as_admin();
select tests.assert_rows($$select 1 from public.locals_waitlist where email = 'nullnote@example.test' and note = ''$$, 1, 'null note is stored as empty');
select tests.assert_rows($$select 1 from public.locals_waitlist where email = 'limits@example.test'$$, 1, 'values at the limits are accepted');

rollback;
