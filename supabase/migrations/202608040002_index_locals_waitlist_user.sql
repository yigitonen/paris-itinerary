create index locals_waitlist_user_idx
  on public.locals_waitlist (user_id)
  where user_id is not null;
