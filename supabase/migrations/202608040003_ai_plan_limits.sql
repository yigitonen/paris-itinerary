create table public.ai_plan_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_bucket bigint not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_bucket)
);

create index ai_plan_requests_user_created_idx
  on public.ai_plan_requests (user_id, created_at desc);

alter table public.ai_plan_requests enable row level security;

create policy "owners read AI plan requests"
on public.ai_plan_requests for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "owners create AI plan requests"
on public.ai_plan_requests for insert
to authenticated
with check ((select auth.uid()) = user_id);

revoke all on public.ai_plan_requests from anon, authenticated;
grant select, insert on public.ai_plan_requests to authenticated;
