create policy "clients cannot access place usage ledger"
on public.place_search_requests
for all
to anon, authenticated
using (false)
with check (false);
