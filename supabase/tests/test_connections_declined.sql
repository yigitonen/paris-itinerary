-- Declined connection requests cannot be re-sent by deleting the declined row.
\set ON_ERROR_STOP on
begin;
\ir lib.sql

select tests.make_user('aaaaaaaa-0000-4000-8000-00000000000a', 'a@example.test') as a \gset
select tests.make_user('bbbbbbbb-0000-4000-8000-00000000000b', 'b@example.test') as b \gset
select tests.make_user('cccccccc-0000-4000-8000-00000000000c', 'c@example.test') as c \gset
select tests.make_user('dddddddd-0000-4000-8000-00000000000d', 'd@example.test') as d \gset

insert into public.profiles (user_id, handle, display_name) values
  (:'a', 'alice', 'Alice'), (:'b', 'bobby', 'Bob'), (:'c', 'carol', 'Carol'), (:'d', 'dave', 'Dave');

-- A requests B, B declines.
select tests.as_user(:'a');
select tests.assert_affects(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'a', :'b'), 1, 'A requests B');
select tests.as_user(:'b');
select tests.assert_affects($$update public.connections set status = 'declined'$$, 1, 'B declines');

-- The requester can no longer delete the declined row, so cannot request again.
select tests.as_user(:'a');
select tests.assert_affects($$delete from public.connections$$, 0, 'requester cannot delete a declined connection');
select tests.assert_rows($$select 1 from public.connections where status = 'declined'$$, 1, 'the declined row is still there');
select tests.assert_denied(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'a', :'b'), 'requester cannot re-request after a decline', '23505');
-- Nor can B's side be requested the other way round while the row exists (unique pair).
select tests.as_user(:'b');
select tests.assert_denied(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'b', :'a'), 'reverse request is blocked by the unique pair', '23505');

-- The addressee may clear it (changing their mind), after which a new request is possible.
select tests.assert_affects($$delete from public.connections$$, 1, 'addressee can delete a declined connection');
select tests.as_user(:'a');
select tests.assert_affects(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'a', :'b'), 1, 'A can request again once B cleared the declined row');

-- Cancel my pending request: the requester can delete while pending.
select tests.assert_affects($$delete from public.connections where status = 'pending'$$, 1, 'requester can cancel a pending request');
select tests.assert_rows($$select 1 from public.connections$$, 0, 'cancelled request is gone');

-- Remove friend: either side can delete an accepted connection.
select tests.assert_affects(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'a', :'c'), 1, 'A requests C');
select tests.as_user(:'c');
select tests.assert_affects($$update public.connections set status = 'accepted'$$, 1, 'C accepts');
select tests.as_user(:'a');
select tests.assert_affects($$delete from public.connections$$, 1, 'requester can remove an accepted friend');

select tests.assert_affects(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'a', :'c'), 1, 'A requests C again');
select tests.as_user(:'c');
select tests.assert_affects($$update public.connections set status = 'accepted'$$, 1, 'C accepts again');
select tests.assert_affects($$delete from public.connections$$, 1, 'addressee can remove an accepted friend');

-- Outsiders still cannot delete anything.
select tests.as_user(:'d');
select tests.assert_affects($$delete from public.connections$$, 0, 'a non-participant deletes nothing');

-- The addressee can also decline-then-delete a pending request they received.
select tests.as_user(:'b');
select tests.assert_affects(format($$insert into public.connections (requester_id, addressee_id) values (%L, %L)$$, :'b', :'d'), 1, 'B requests D');
select tests.as_user(:'d');
select tests.assert_affects($$delete from public.connections where status = 'pending'$$, 1, 'addressee can delete a pending request');

rollback;
