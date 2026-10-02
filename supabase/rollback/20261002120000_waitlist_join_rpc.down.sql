-- Rollback for 20261002120000_waitlist_join_rpc.sql.
-- Restores direct anon/authenticated INSERT access to public.locals_waitlist (policy and
-- grants as in 202608040001_core_travel.sql) and drops join_locals_waitlist().
--
-- WARNING: this re-opens the e-mail enumeration (a repeat insert returns 23505). Roll the
-- web app back to a revision that inserts into the table directly BEFORE or together with
-- this script, or the sign-up form will fail: the current client only calls the function.
-- Idempotent.
begin;

drop function if exists public.join_locals_waitlist(text, text, text);

drop policy if exists "visitors join locals waitlist" on public.locals_waitlist;
create policy "visitors join locals waitlist"
on public.locals_waitlist for insert
to anon, authenticated
with check (user_id is null or (select auth.uid()) = user_id);

grant insert on public.locals_waitlist to anon;
grant insert on public.locals_waitlist to authenticated;

commit;
