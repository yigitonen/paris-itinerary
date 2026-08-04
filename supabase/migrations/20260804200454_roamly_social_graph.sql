create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique
    check (handle ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  display_name text not null
    check (char_length(display_name) between 1 and 80),
  avatar_url text
    check (avatar_url is null or (char_length(avatar_url) <= 2048 and avatar_url ~ '^https://')),
  discoverable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_discoverable_handle_idx
  on public.profiles (handle text_pattern_ops)
  where discoverable;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function private.set_updated_at();

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(user_id) on delete cascade,
  addressee_id uuid not null references public.profiles(user_id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> addressee_id)
);

create unique index connections_unique_pair_idx
  on public.connections (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );

create index connections_requester_updated_idx
  on public.connections (requester_id, updated_at desc);

create index connections_addressee_updated_idx
  on public.connections (addressee_id, updated_at desc);

create trigger connections_set_updated_at
before update on public.connections
for each row execute function private.set_updated_at();

create or replace function private.prevent_connection_identity_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.requester_id is distinct from old.requester_id
    or new.addressee_id is distinct from old.addressee_id then
    raise exception 'Connection participants cannot be changed.' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_connection_identity_change()
  from public, anon, authenticated;

create trigger connections_keep_participants
before update on public.connections
for each row execute function private.prevent_connection_identity_change();

alter table public.profiles enable row level security;
alter table public.connections enable row level security;

create policy "users create their profile"
on public.profiles for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "users update their profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "authenticated users discover profiles"
on public.profiles for select
to authenticated
using (
  (select auth.uid()) = user_id
  or discoverable
  or exists (
    select 1
    from public.connections
    where (
      requester_id = (select auth.uid()) and addressee_id = profiles.user_id
    ) or (
      addressee_id = (select auth.uid()) and requester_id = profiles.user_id
    )
  )
);

create policy "participants read connections"
on public.connections for select
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

create policy "requesters create pending connections"
on public.connections for insert
to authenticated
with check (
  (select auth.uid()) = requester_id
  and requester_id <> addressee_id
  and status = 'pending'
);

create policy "addressees respond to pending connections"
on public.connections for update
to authenticated
using (
  (select auth.uid()) = addressee_id
  and status = 'pending'
)
with check (
  (select auth.uid()) = addressee_id
  and status in ('accepted', 'declined')
);

create policy "participants remove connections"
on public.connections for delete
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (user_id, handle, display_name, avatar_url, discoverable)
  on public.profiles to authenticated;
grant update (handle, display_name, avatar_url, discoverable)
  on public.profiles to authenticated;

revoke all on public.connections from anon, authenticated;
grant select, delete on public.connections to authenticated;
grant insert (requester_id, addressee_id, status)
  on public.connections to authenticated;
grant update (status) on public.connections to authenticated;
