-- Rollback for 20261002121000_trips_plan_size_cap.sql.
-- Removes the size cap on public.trips.plan. Idempotent. No data is touched.
begin;

alter table public.trips drop constraint if exists trips_plan_size_check;

commit;
