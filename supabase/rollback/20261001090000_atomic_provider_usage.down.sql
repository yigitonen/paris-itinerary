-- Rollback for 20261001090000_atomic_provider_usage.sql.
-- Drops reserve_provider_usage / finish_provider_usage and the provider_usage ledger, and
-- removes the "superseded" comments from the legacy tables the previous Edge Function
-- revision still reads and writes (ai_plan_requests, place_search_requests).
--
-- Redeploy the previous plan-trip and places functions first (they use the legacy tables);
-- the current ones call the functions dropped here and would fail closed (503
-- quota_unavailable) afterwards.
--
-- DESTRUCTIVE: provider_usage rows are lost, and usage recorded only there stops counting.
-- To keep a copy first:  create table public.provider_usage_backup as table public.provider_usage;
-- (drop it when no longer needed). Idempotent.
begin;

drop function if exists public.reserve_provider_usage(uuid, text, text, int, int, int, int, int, int);
drop function if exists public.finish_provider_usage(uuid, boolean, text);
drop table if exists public.provider_usage;

comment on table public.ai_plan_requests is null;
comment on table public.place_search_requests is
  'Server-only request ledger used to cap paid Google Places traffic per signed-in user.';

commit;
