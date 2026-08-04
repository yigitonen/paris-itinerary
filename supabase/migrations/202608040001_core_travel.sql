-- Roamly core travel data. The previous anonymous JSON table had no usable RLS policy.
drop table if exists public.trips cascade;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 100),
  destination text not null check (char_length(destination) between 1 and 100),
  country text not null default '' check (char_length(country) <= 100),
  start_date date not null,
  end_date date not null,
  status text not null default 'planning' check (status in ('planning', 'upcoming', 'active', 'past')),
  style text not null default 'Dengeli' check (char_length(style) between 1 and 40),
  pace text not null default 'Rahat' check (char_length(pace) between 1 and 40),
  cover_key text not null default 'default' check (char_length(cover_key) between 1 and 40),
  budget_total numeric(12,2) not null default 0 check (budget_total >= 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  plan jsonb not null default '{"source":"manual","days":[],"expenses":[],"journals":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (jsonb_typeof(plan) = 'object'),
  check (jsonb_typeof(plan -> 'days') = 'array'),
  check (jsonb_typeof(plan -> 'expenses') = 'array'),
  check (jsonb_typeof(plan -> 'journals') = 'array')
);

create index trips_owner_start_idx on public.trips(owner_id, start_date);
create index trips_owner_updated_idx on public.trips(owner_id, updated_at desc);

create trigger trips_set_updated_at
before update on public.trips
for each row execute function private.set_updated_at();

alter table public.trips enable row level security;

create policy "owners read trips"
on public.trips for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners create trips"
on public.trips for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy "owners update trips"
on public.trips for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy "owners delete trips"
on public.trips for delete
to authenticated
using ((select auth.uid()) = owner_id);

revoke all on public.trips from anon, authenticated;
grant select, insert, update, delete on public.trips to authenticated;

create table public.locals_waitlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  email text not null check (char_length(email) between 5 and 254),
  city text not null check (char_length(city) between 1 and 100),
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);

create unique index locals_waitlist_email_city_idx on public.locals_waitlist(lower(email), lower(city));
alter table public.locals_waitlist enable row level security;

create policy "visitors join locals waitlist"
on public.locals_waitlist for insert
to anon, authenticated
with check (user_id is null or (select auth.uid()) = user_id);

create policy "users read own waitlist entry"
on public.locals_waitlist for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.locals_waitlist from anon, authenticated;
grant insert on public.locals_waitlist to anon;
grant select, insert on public.locals_waitlist to authenticated;

