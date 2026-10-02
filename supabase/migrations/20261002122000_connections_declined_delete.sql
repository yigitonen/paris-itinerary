-- A declined connection request must stay declined for the requester.
--
-- The delete policy let either participant remove any row, so a requester whose request
-- was declined could delete the row (which frees the unique pair) and send the request
-- again, indefinitely. Now:
--   * the addressee may delete the connection in any state (including declining and later
--     clearing it, which is how they choose to be requestable again);
--   * the requester may delete it while it is pending (cancel a request) or accepted
--     (remove a friend), but not once it is declined.
-- The UI only offers "remove" on accepted connections, so no existing flow changes.

drop policy if exists "participants remove connections" on public.connections;

create policy "participants remove connections"
on public.connections for delete
to authenticated
using (
  (select auth.uid()) = addressee_id
  or ((select auth.uid()) = requester_id and status <> 'declined')
);
