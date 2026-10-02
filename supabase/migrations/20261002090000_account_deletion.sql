-- Account deletion support (App Store 5.1.1(v) / Google Play account deletion policy).
--
-- Deleting a row from auth.users already cascades to every per-user table:
--   public.trips (owner_id; days, stops, expenses and journals live in trips.plan),
--   public.profiles (user_id) and, through it, public.connections,
--   public.ai_plan_requests, public.place_search_requests, public.provider_usage.
-- No Storage buckets or other tables reference auth.users or hold personal data.
--
-- public.locals_waitlist was the exception: its user_id foreign key was ON DELETE
-- SET NULL and the row keeps the e-mail address, so the address survived account
-- deletion. Visitors can also join the waitlist while signed out (user_id is null,
-- e-mail only), so rows can belong to a person without being linked to the account.
--
-- This migration:
--   1. changes locals_waitlist.user_id to ON DELETE CASCADE, so linked rows go away
--      even if the cleanup function below is skipped;
--   2. adds public.delete_account_data(uuid), called by the delete-account Edge
--      Function just before it deletes the auth user, which also removes waitlist
--      rows that were joined signed out with the account's e-mail address.

-- 1. Replace the SET NULL foreign key. Looked up by definition instead of by name so
--    it also works if the constraint was renamed or this migration is re-run.
do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.locals_waitlist'::regclass
      and c.contype = 'f'
      and c.confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.locals_waitlist drop constraint %I', v_constraint);
  end loop;
end;
$$;

alter table public.locals_waitlist
  add constraint locals_waitlist_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- 2. Cleanup for data that cannot cascade. Service role only: it takes any user id.
create or replace function public.delete_account_data(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_waitlist int;
begin
  if p_user_id is null then
    raise exception 'delete_account_data: user id is required';
  end if;

  select u.email into v_email from auth.users u where u.id = p_user_id;

  -- Entries linked to the account, plus entries joined while signed out (or from
  -- another session) with the account's e-mail address, matched case-insensitively.
  delete from public.locals_waitlist w
  where w.user_id = p_user_id
     or (
       nullif(btrim(coalesce(v_email, '')), '') is not null
       and lower(btrim(w.email)) = lower(btrim(v_email))
     );
  get diagnostics v_waitlist = row_count;

  return jsonb_build_object('waitlist_deleted', v_waitlist);
end;
$$;

revoke execute on function public.delete_account_data(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid)
  to service_role;

comment on function public.delete_account_data(uuid) is
  'Removes personal data that does not cascade from auth.users (locals_waitlist rows by user id and by the account e-mail). Called by the delete-account Edge Function before auth.admin.deleteUser. Service role only.';
