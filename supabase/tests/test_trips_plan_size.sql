-- public.trips.plan is capped (trips_plan_size_check: plan::text <= 2,000,000 bytes).
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset

select tests.assert_true(
  (select not convalidated from pg_constraint where conrelid = 'public.trips'::regclass and conname = 'trips_plan_size_check'),
  'size cap exists and is NOT VALID (existing rows are not scanned)');

select tests.as_user(:'a');

-- A realistic plan is accepted.
select tests.assert_affects($$insert into public.trips (id, owner_id, title, destination, start_date, end_date, plan) values ('a1a1a1a1-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'ok', 'Paris', '2026-01-01', '2026-01-02',
  jsonb_build_object('source', 'manual', 'days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', jsonb_build_array(jsonb_build_object('title', 'j', 'body', repeat('x', 20000)))))$$, 1, 'normal plan with a 20k-char journal');

-- A plan just under the cap is accepted, just over is rejected (23514 check_violation).
select tests.assert_affects($$insert into public.trips (id, owner_id, title, destination, start_date, end_date, plan) values ('a1a1a1a1-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-00000000000a', 'edge', 'Paris', '2026-01-01', '2026-01-02',
  jsonb_build_object('days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', '[]'::jsonb, 'pad', repeat('x', 1999900)))$$, 1, 'plan just under the cap');
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date, plan) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'big', 'Paris', '2026-01-01', '2026-01-02',
  jsonb_build_object('days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', '[]'::jsonb, 'pad', repeat('x', 2000001)))$$, 'oversize insert is rejected', '23514');
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date, plan) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'big', 'Paris', '2026-01-01', '2026-01-02',
  jsonb_build_object('days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', (select jsonb_agg(jsonb_build_object('title', 'j' || i, 'body', repeat('y', 20000))) from generate_series(1, 150) i)))$$, 'many large journals are rejected', '23514');

-- Updates are capped too.
select tests.assert_denied($$update public.trips set plan = jsonb_set(plan, '{pad}', to_jsonb(repeat('z', 2100000))) where id = 'a1a1a1a1-0000-4000-8000-000000000001'$$, 'oversize update is rejected', '23514');
select tests.assert_affects($$update public.trips set plan = jsonb_set(plan, '{note}', '"small"') where id = 'a1a1a1a1-0000-4000-8000-000000000001'$$, 1, 'small update still works');

-- Multi-byte text counts in bytes: 700k three-byte characters is over the cap although it is under 1M characters.
select tests.assert_denied($$insert into public.trips (owner_id, title, destination, start_date, end_date, plan) values ('aaaaaaaa-0000-4000-8000-00000000000a', 'cjk', 'Tokyo', '2026-01-01', '2026-01-02',
  jsonb_build_object('days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', '[]'::jsonb, 'pad', repeat('日', 700000)))$$, 'cap counts bytes', '23514');

-- NOT VALID semantics: a pre-existing oversized row must not block (re-)applying the migration.
select tests.as_admin();
alter table public.trips drop constraint trips_plan_size_check;
insert into public.trips (id, owner_id, title, destination, start_date, end_date, plan) values ('a1a1a1a1-0000-4000-8000-000000000009', :'a', 'legacy', 'Paris', '2026-01-01', '2026-01-02',
  jsonb_build_object('days', '[]'::jsonb, 'expenses', '[]'::jsonb, 'journals', '[]'::jsonb, 'pad', repeat('x', 3000000)));
\ir ../migrations/20261002121000_trips_plan_size_cap.sql
select tests.assert_true(
  (select not convalidated from pg_constraint where conrelid = 'public.trips'::regclass and conname = 'trips_plan_size_check'),
  'migration applies over an existing oversized row and leaves the constraint NOT VALID');
select tests.as_user(:'a');
select tests.assert_rows($$select 1 from public.trips where id = 'a1a1a1a1-0000-4000-8000-000000000009'$$, 1, 'the legacy row is still readable');
select tests.assert_affects($$delete from public.trips where id = 'a1a1a1a1-0000-4000-8000-000000000009'$$, 1, 'and deletable');

rollback;
