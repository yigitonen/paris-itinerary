-- Minimal Supabase compatibility layer for running supabase/migrations on a
-- plain PostgreSQL 16 cluster. It mirrors the parts of a Supabase project that
-- the migrations and RLS policies depend on; it is NOT a full Supabase image.
--
-- Run once, as the superuser that plays "postgres", on an empty database,
-- before applying the migrations (supabase/tests/run.sh does all of this):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/bootstrap.sql
--
-- Mirrored from Supabase:
--   * roles anon / authenticated (NOLOGIN, NOINHERIT), service_role (NOLOGIN,
--     NOINHERIT, BYPASSRLS) and authenticator (LOGIN, NOINHERIT) which can
--     switch into the other three
--   * schema auth with auth.users and auth.uid() / auth.role() / auth.jwt() /
--     auth.email() reading request.jwt.claims exactly like GoTrue/PostgREST
--   * the default privileges Supabase installs on schema public: ALL on every
--     new table, function and sequence goes to anon, authenticated and
--     service_role. Migrations must REVOKE what they do not want exposed, so
--     the tests are only meaningful with these defaults in place.
--   * schema extensions on the database search_path
-- Not mirrored: the storage schema (no migration references it), realtime,
-- PostgREST itself, auth.users columns the migrations do not use.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;

-- Extensions. gen_random_uuid() is built in since PG13; pgcrypto and uuid-ossp
-- are installed when the server ships them (Debian's contrib may be absent).
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
do $$
begin
  create extension if not exists pgcrypto with schema extensions;
  create extension if not exists "uuid-ossp" with schema extensions;
exception when others then
  raise notice 'bootstrap: contrib extensions unavailable (%), continuing', sqlerrm;
end
$$;

-- Supabase sets the database search_path like this.
do $$
begin
  execute format('alter database %I set search_path to "$user", public, extensions', current_database());
end
$$;
set search_path to "$user", public, extensions;

-- auth schema ---------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb,
  created_at timestamptz not null default now()
);
-- GoTrue's tables are not readable by the API roles.
revoke all on table auth.users from public, anon, authenticated;
grant all on table auth.users to service_role;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to anon, authenticated, service_role;

-- public schema defaults ----------------------------------------------------
-- Supabase: usage on schema public for the API roles, and ALL on everything the
-- postgres role creates there afterwards.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
