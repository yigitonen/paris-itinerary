-- Bound public.trips.plan. The column is jsonb with only shape checks, so a signed-in
-- user could store an arbitrarily large document (every owner has insert/update on it).
--
-- Cap: the text form of the plan may not exceed 2,000,000 bytes. A realistic trip is
-- around 100 KB, so this is roughly 20x headroom; it is deterministic (unlike
-- pg_column_size, which reports the compressed size once a value is TOASTed).
--
-- The constraint is added NOT VALID: it is enforced for every INSERT and UPDATE from now
-- on, but existing rows are not scanned, so a live row that is already too large cannot
-- make this migration fail. Note that an UPDATE of such a row (any column) is rejected
-- until its plan is shrunk below the cap.
--
-- Later, once no oversized rows remain:
--   select id, octet_length(plan::text) from public.trips where octet_length(plan::text) > 2000000;
--   alter table public.trips validate constraint trips_plan_size_check;
-- VALIDATE only takes a SHARE UPDATE EXCLUSIVE lock, so reads and writes continue.

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.trips'::regclass and conname = 'trips_plan_size_check'
  ) then
    alter table public.trips
      add constraint trips_plan_size_check
      check (octet_length(plan::text) <= 2000000) not valid;
  end if;
end;
$$;
