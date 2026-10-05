-- Rollback for 20261002090000_account_deletion.sql.
-- Drops delete_account_data(uuid) and restores locals_waitlist.user_id as ON DELETE SET NULL.
--
-- WARNING: with SET NULL, deleting an account leaves the e-mail address on the waitlist
-- (the privacy gap this migration closed). The delete-account Edge Function calls
-- delete_account_data, so redeploy a revision without it (or remove the function) first.
-- Idempotent.
begin;

drop function if exists public.delete_account_data(uuid);

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
  foreign key (user_id) references auth.users(id) on delete set null;

commit;
