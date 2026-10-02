-- Shared helpers for the SQL tests. Included with \ir inside a transaction that
-- the test rolls back, so nothing here (or any test data) persists.
--
-- Pattern used by the tests:
--   select tests.as_user('<uuid>');   -- like a PostgREST request with that JWT
--   select tests.as_anon();
--   select tests.as_service();
--   select tests.as_admin();          -- back to the superuser ("postgres")
-- and then plain statements or the assert helpers, which run as the current role.

create schema tests;
grant usage on schema tests to public;

create function tests.as_admin() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

create function tests.as_user(p_user uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
end $$;

create function tests.as_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end $$;

create function tests.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end $$;

-- Fails unless the query returns exactly p_expected rows.
create function tests.assert_rows(p_sql text, p_expected bigint, p_label text) returns void
language plpgsql as $$
declare v bigint;
begin
  execute format('select count(*) from (%s) q', p_sql) into v;
  if v is distinct from p_expected then
    raise exception 'FAIL [%]: expected % rows, got % (as %)', p_label, p_expected, v, current_user;
  end if;
end $$;

-- Fails unless the statement affects exactly p_expected rows (RLS-hidden rows
-- count as zero, which is how PostgREST reports them too).
create function tests.assert_affects(p_sql text, p_expected bigint, p_label text) returns void
language plpgsql as $$
declare v bigint;
begin
  execute p_sql;
  get diagnostics v = row_count;
  if v is distinct from p_expected then
    raise exception 'FAIL [%]: expected % rows affected, got % (as %)', p_label, p_expected, v, current_user;
  end if;
exception when others then
  if sqlerrm like 'FAIL [%' then raise; end if;
  raise exception 'FAIL [%]: unexpected error % (%) (as %)', p_label, sqlerrm, sqlstate, current_user;
end $$;

-- Fails unless the statement is rejected with SQLSTATE p_state (default 42501,
-- insufficient_privilege, which is also what an RLS WITH CHECK violation raises).
create function tests.assert_denied(p_sql text, p_label text, p_state text default '42501') returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL [%]: statement was allowed (as %): %', p_label, current_user, p_sql;
exception when others then
  if sqlerrm like 'FAIL [%' then raise; end if;
  if sqlstate <> p_state then
    raise exception 'FAIL [%]: expected SQLSTATE % but got % (%) (as %)', p_label, p_state, sqlstate, sqlerrm, current_user;
  end if;
end $$;

create function tests.assert_true(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL [%]', p_label; end if;
end $$;

create function tests.assert_eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
end $$;

-- Creates an auth user (as admin) and returns its id.
create function tests.make_user(p_id uuid, p_email text) returns uuid language plpgsql as $$
begin
  insert into auth.users (id, email) values (p_id, p_email);
  return p_id;
end $$;
