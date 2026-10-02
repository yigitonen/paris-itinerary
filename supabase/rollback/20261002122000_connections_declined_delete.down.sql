-- Rollback for 20261002122000_connections_declined_delete.sql.
-- Restores the original delete policy: either participant may delete a connection in any
-- state (which also re-allows a requester to clear a declined request and ask again).
-- Idempotent. No Edge Function change is involved.
begin;

drop policy if exists "participants remove connections" on public.connections;

create policy "participants remove connections"
on public.connections for delete
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

commit;
