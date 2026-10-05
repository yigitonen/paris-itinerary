-- Locals waitlist: stop leaking who is on it.
--
-- The table accepted direct inserts from anon, and the unique index on
-- (lower(email), lower(city)) turned a repeat sign-up into a 23505 error, so anyone
-- could probe whether an e-mail address is on the waitlist. Joining now goes through
-- public.join_locals_waitlist(), which answers the same way for a new and for an
-- existing entry. Direct INSERT access (grants and policy) is removed; the existing
-- "users read own waitlist entry" SELECT policy is untouched.

create or replace function public.join_locals_waitlist(p_email text, p_city text, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := btrim(coalesce(p_email, ''));
  v_city text := btrim(coalesce(p_city, ''));
  v_note text := coalesce(p_note, '');
begin
  -- Same limits as the table checks. These errors depend only on the caller's own
  -- input, never on what is already stored.
  if char_length(v_email) not between 5 and 254 then
    raise exception 'join_locals_waitlist: email must be 5 to 254 characters' using errcode = '22023';
  end if;
  if char_length(v_city) not between 1 and 100 then
    raise exception 'join_locals_waitlist: city must be 1 to 100 characters' using errcode = '22023';
  end if;
  if char_length(v_note) > 500 then
    raise exception 'join_locals_waitlist: note must be at most 500 characters' using errcode = '22023';
  end if;

  -- user_id is always the caller (null for anon), never client-supplied. A duplicate
  -- (case-insensitive e-mail + city) is silently ignored.
  insert into public.locals_waitlist (user_id, email, city, note)
  values ((select auth.uid()), v_email, v_city, v_note)
  on conflict (lower(email), lower(city)) do nothing;

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.join_locals_waitlist(text, text, text) from public, anon, authenticated;
grant execute on function public.join_locals_waitlist(text, text, text) to anon, authenticated;

comment on function public.join_locals_waitlist(text, text, text) is
  'Joins the locals waitlist. Returns {"ok": true} whether or not the (email, city) entry already existed, so it cannot be used to test whether an e-mail address is on the list.';

-- Direct inserts are no longer needed (or allowed).
drop policy if exists "visitors join locals waitlist" on public.locals_waitlist;
revoke insert on public.locals_waitlist from anon, authenticated;
